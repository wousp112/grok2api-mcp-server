#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as dotenv from 'dotenv';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { extractAssistantTextFromUpstreamData } from './lib/upstream-response.js';

// Always load .env from this script's directory, regardless of process cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

const SERVER_NAME = 'grok-mcp-server';
const SERVER_VERSION = '1.2.0';

// ── Required configuration ──────────────────────────────────────────
const API_BASE_URL = process.env.GROK_API_URL;
const API_KEY = process.env.GROK_API_KEY || '';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-3';

// ── Optional tuning ─────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = readIntEnv('GROK_REQUEST_TIMEOUT_MS', 90000, 1000, 300000);
const MAX_RETRIES = readIntEnv('GROK_MAX_RETRIES', 2, 0, 8);
const BACKOFF_BASE_MS = readIntEnv('GROK_BACKOFF_BASE_MS', 800, 100, 30000);
const READ_TIMEOUT_MS = readIntEnv('GROK_READ_TIMEOUT_MS', REQUEST_TIMEOUT_MS, 1000, 300000);
const TOTAL_TIMEOUT_MS = readIntEnv('GROK_TOTAL_TIMEOUT_MS', 110000, 1000, 300000);
const DEBUG_LOG_PATH = process.env.GROK_MCP_DEBUG_LOG || '';

// ── Runtime metrics ─────────────────────────────────────────────────
const runtimeStats = {
    started_at: nowIso(),
    tool_calls_total: 0,
    tool_calls_success: 0,
    tool_calls_error: 0,
    upstream_attempts_total: 0,
    upstream_failures_total: 0,
    errors_by_code: {},
};
let callSeq = 0;

// ── Helpers ─────────────────────────────────────────────────────────
function debugLog(message, extra) {
    if (!DEBUG_LOG_PATH) return;
    try {
        const line = `[${nowIso()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
        fs.appendFileSync(DEBUG_LOG_PATH, line, 'utf8');
    } catch {
        // Never let debug logging break the server.
    }
}

function makeRequestId() {
    const rand = Math.random().toString(36).slice(2, 8);
    return `grok-${Date.now().toString(36)}-${rand}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
    return new Date().toISOString();
}

function readIntEnv(name, defaultValue, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return defaultValue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < min || value > max) {
        console.error(`[${SERVER_NAME}] Invalid ${name}=${raw}. Using default ${defaultValue}.`);
        return defaultValue;
    }
    return value;
}

process.on('uncaughtException', (error) => {
    debugLog('uncaughtException', { message: error?.message, stack: error?.stack });
    console.error(`[${SERVER_NAME}] uncaughtException`, error);
});

process.on('unhandledRejection', (reason) => {
    debugLog('unhandledRejection', { reason: String(reason), stack: reason?.stack });
    console.error(`[${SERVER_NAME}] unhandledRejection`, reason);
});

process.on('exit', (code) => {
    debugLog('process_exit', { code });
});

process.on('SIGTERM', () => {
    debugLog('signal', { signal: 'SIGTERM' });
});

process.on('SIGINT', () => {
    debugLog('signal', { signal: 'SIGINT' });
});

// Detached/background launches on macOS can emit SIGHUP when the parent shell exits.
// Handle it explicitly so the local HTTP daemon can stay alive outside the invoking shell.
process.on('SIGHUP', () => {
    debugLog('signal', { signal: 'SIGHUP' });
});

function classifyAxiosError(error) {
    if (!axios.isAxiosError(error)) {
        return { code: 'UNKNOWN_ERROR', message: String(error), retryable: false, status: undefined };
    }
    const status = error.response?.status;
    const upstreamMessage = error.response?.data?.error?.message || error.message || 'unknown axios error';

    if (!API_KEY) {
        return { code: 'AUTH_MISSING', message: 'GROK_API_KEY is not configured', retryable: false, status };
    }
    if (status === 401 || status === 403) {
        return { code: 'AUTH_INVALID', message: upstreamMessage, retryable: false, status };
    }
    if (status === 429) {
        return { code: 'UPSTREAM_RATE_LIMIT', message: upstreamMessage, retryable: true, status };
    }
    if (status && status >= 500) {
        return { code: 'UPSTREAM_5XX', message: upstreamMessage, retryable: true, status };
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
        return { code: 'UPSTREAM_TIMEOUT', message: upstreamMessage, retryable: true, status };
    }
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'EAI_AGAIN') {
        return { code: 'NETWORK_ERROR', message: upstreamMessage, retryable: true, status };
    }
    return { code: 'UPSTREAM_4XX', message: upstreamMessage, retryable: false, status };
}

async function postWithRetry({ requestId, body, headers }) {
    let attempts = 0;
    const startedAt = Date.now();
    const deadlineAt = startedAt + TOTAL_TIMEOUT_MS;

    while (attempts <= MAX_RETRIES) {
        const remainingBudgetMs = deadlineAt - Date.now();
        if (remainingBudgetMs <= 0) {
            const finalError = new Error('Total request budget exhausted before Grok returned a response.');
            finalError.code = 'MCP_TOTAL_TIMEOUT';
            finalError.status = undefined;
            finalError.attempts = attempts;
            finalError.totalLatencyMs = Date.now() - startedAt;
            throw finalError;
        }

        attempts += 1;
        runtimeStats.upstream_attempts_total += 1;
        const attemptStart = Date.now();
        const attemptTimeoutMs = Math.max(1000, Math.min(READ_TIMEOUT_MS, remainingBudgetMs));
        try {
            const response = await axios.post(
                `${API_BASE_URL}/chat/completions`,
                body,
                {
                    headers,
                    timeout: attemptTimeoutMs,
                    transitional: { clarifyTimeoutError: true },
                }
            );
            const latencyMs = Date.now() - attemptStart;
            console.error(`[${SERVER_NAME}] request_id=${requestId} event=upstream_ok attempt=${attempts} status=${response.status} latency_ms=${latencyMs}`);
            return {
                response,
                attempts,
                totalLatencyMs: Date.now() - startedAt,
            };
        } catch (error) {
            runtimeStats.upstream_failures_total += 1;
            const info = classifyAxiosError(error);
            const latencyMs = Date.now() - attemptStart;
            console.error(
                `[${SERVER_NAME}] request_id=${requestId} event=upstream_err attempt=${attempts} code=${info.code} status=${info.status ?? 'n/a'} latency_ms=${latencyMs} retryable=${info.retryable}`
            );
            if (!info.retryable || attempts > MAX_RETRIES) {
                const finalError = new Error(info.message);
                finalError.code = info.code;
                finalError.status = info.status;
                finalError.attempts = attempts;
                finalError.totalLatencyMs = Date.now() - startedAt;
                throw finalError;
            }
            const backoff = BACKOFF_BASE_MS * (2 ** (attempts - 1));
            const remainingAfterFailureMs = deadlineAt - Date.now();
            if (remainingAfterFailureMs <= backoff + 1000) {
                const finalError = new Error(`${info.message} (retry budget exhausted)`);
                finalError.code = info.code;
                finalError.status = info.status;
                finalError.attempts = attempts;
                finalError.totalLatencyMs = Date.now() - startedAt;
                throw finalError;
            }
            await sleep(Math.min(backoff, remainingAfterFailureMs - 1000));
        }
    }
    throw new Error('Retry loop exited unexpectedly');
}

// ── Option normalization ────────────────────────────────────────────
function normalizeOptions(args) {
    const timeRange = typeof args.time_range === 'string' ? args.time_range : 'all';
    const language = typeof args.language === 'string' ? args.language : 'en';
    const outputMode = typeof args.output_mode === 'string' ? args.output_mode : 'analyst';
    const freshnessDays = Number.isInteger(args.freshness_days) ? args.freshness_days : undefined;
    const maxSources = Number.isInteger(args.max_sources) ? Math.max(1, Math.min(20, args.max_sources)) : 8;
    const domains = Array.isArray(args.domains_allowlist)
        ? args.domains_allowlist.filter((d) => typeof d === 'string' && d.trim().length > 0).slice(0, 30)
        : [];
    return { timeRange, language, outputMode, freshnessDays, maxSources, domains };
}

// ── Prompt construction ─────────────────────────────────────────────
function buildSystemPrompt({ outputMode, language, freshnessDays, domains, maxSources, timeRange }) {
    return [
        'Search the web and X/Twitter for the user query.',
        `Reply in ${language}. Output JSON only.`,
        `Style=${outputMode}; time_range=${timeRange}; freshness_days=${freshnessDays ?? 'n/a'}; max_sources=${maxSources}.`,
        `Preferred domains=${domains.length > 0 ? domains.join(', ') : 'n/a'}.`,
        'Return this shape exactly:',
        '{"summary":"","key_points":[{"point":"","source_urls":[""]}],"sources":[{"title":"","url":"","publisher":"","published_at":"","relevance_note":""}],"confidence":0.0,"as_of":"","notes":""}',
        'Keep summary short. Use direct source URLs. Deduplicate sources. Limit key_points to 6. Limit sources to the requested max_sources. If uncertain, note it briefly and lower confidence.'
    ].join('\n');
}

function buildUserPrompt(query, { timeRange, freshnessDays, domains, maxSources }) {
    return `query=${query}\ntime_range=${timeRange}\nfreshness_days=${freshnessDays ?? 'n/a'}\ndomains=${domains.length > 0 ? domains.join(', ') : 'n/a'}\nmax_sources=${maxSources}`;
}

// ── Response parsing ────────────────────────────────────────────────
function extractJsonObject(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        // Try fenced code block.
    }
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
        try {
            return JSON.parse(fenceMatch[1].trim());
        } catch {
            // keep going
        }
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        const candidate = trimmed.slice(first, last + 1);
        try {
            return JSON.parse(candidate);
        } catch {
            return null;
        }
    }
    return null;
}

function sanitizeStructuredResult(parsed, fallbackText) {
    const result = parsed && typeof parsed === 'object' ? parsed : {};
    const summary = typeof result.summary === 'string' && result.summary.trim() ? result.summary.trim() : String(fallbackText || 'No response generated.');
    const rawKeyPoints = Array.isArray(result.key_points) ? result.key_points : [];
    const key_points = rawKeyPoints.slice(0, 12).map((item) => ({
        point: typeof item?.point === 'string' ? item.point : '',
        source_urls: Array.isArray(item?.source_urls) ? item.source_urls.filter((u) => typeof u === 'string' && u.trim()) : [],
    })).filter((k) => k.point);
    const rawSources = Array.isArray(result.sources) ? result.sources : [];
    const sources = rawSources.slice(0, 30).map((item) => ({
        title: typeof item?.title === 'string' ? item.title : '',
        url: typeof item?.url === 'string' ? item.url : '',
        publisher: typeof item?.publisher === 'string' ? item.publisher : '',
        published_at: typeof item?.published_at === 'string' ? item.published_at : '',
        relevance_note: typeof item?.relevance_note === 'string' ? item.relevance_note : '',
    })).filter((s) => s.url);
    const confidenceRaw = typeof result.confidence === 'number' ? result.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, confidenceRaw));
    const as_of = typeof result.as_of === 'string' && result.as_of.trim() ? result.as_of : nowIso();
    const notes = typeof result.notes === 'string' ? result.notes : '';
    return { summary, key_points, sources, confidence, as_of, notes };
}

function createMcpServer() {
    const server = new Server(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        debugLog('list_tools');
        return {
            tools: [
                {
                    name: 'grok_web_search',
                    description: 'Preferred tool for real-time web and Twitter/X research. Use first when the task involves X/Twitter posts, threads, handles, or fast-moving topics where generic web search or direct page fetches may miss context or hit access limits. Returns structured results with source URLs.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'The precise question, X/Twitter post, account, handle, thread, or topic to search for.'
                            },
                            output_mode: {
                                type: 'string',
                                enum: ['brief', 'analyst', 'raw'],
                                description: 'Response style. brief=short actionable, analyst=deeper synthesis, raw=include more raw context.'
                            },
                            language: {
                                type: 'string',
                                description: 'Preferred response language, e.g. zh or en.'
                            },
                            time_range: {
                                type: 'string',
                                enum: ['24h', '7d', '30d', 'all'],
                                description: 'Preferred search lookback window.'
                            },
                            freshness_days: {
                                type: 'integer',
                                description: 'Prefer sources within this many days when possible.'
                            },
                            max_sources: {
                                type: 'integer',
                                description: 'Target max source count in structured output (1-20).'
                            },
                            domains_allowlist: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Preferred source domains.'
                            },
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'grok_stats',
                    description: 'Return runtime call counters for this MCP process (tool calls, retries, error code distribution).',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    }
                },
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        debugLog('call_tool_received', { name, hasArgs: Boolean(args) });

        if (name === 'grok_stats') {
            const snapshot = {
                ...runtimeStats,
                uptime_sec: Math.floor((Date.now() - new Date(runtimeStats.started_at).getTime()) / 1000),
            };
            return {
                content: [
                    {
                        type: 'text',
                        text: `tool_calls_total=${snapshot.tool_calls_total}, success=${snapshot.tool_calls_success}, error=${snapshot.tool_calls_error}, upstream_attempts=${snapshot.upstream_attempts_total}, upstream_failures=${snapshot.upstream_failures_total}`
                    }
                ],
                structuredContent: snapshot,
            };
        }

        if (name === 'grok_web_search') {
            runtimeStats.tool_calls_total += 1;
            const thisCallSeq = ++callSeq;
            debugLog('grok_web_search_begin', { call_seq: thisCallSeq, query: args?.query, args });

            if (!API_BASE_URL) {
                runtimeStats.tool_calls_error += 1;
                runtimeStats.errors_by_code.CONFIG_MISSING = (runtimeStats.errors_by_code.CONFIG_MISSING || 0) + 1;
                return {
                    content: [{ type: 'text', text: 'Error [CONFIG_MISSING]: GROK_API_URL is not configured. Set it in your .env file.' }],
                    structuredContent: { error: { code: 'CONFIG_MISSING', message: 'GROK_API_URL is not configured' } },
                    isError: true,
                };
            }

            if (!args || typeof args.query !== 'string') {
                throw new Error(`Invalid arguments for tool ${name}`);
            }
            if (!API_KEY) {
                runtimeStats.tool_calls_error += 1;
                runtimeStats.errors_by_code.AUTH_MISSING = (runtimeStats.errors_by_code.AUTH_MISSING || 0) + 1;
                return {
                    content: [{ type: 'text', text: 'Error [AUTH_MISSING]: GROK_API_KEY is not configured. Set it in your .env file.' }],
                    structuredContent: { error: { code: 'AUTH_MISSING', message: 'GROK_API_KEY is not configured' } },
                    isError: true,
                };
            }

            const query = args.query;
            const requestId = makeRequestId();
            const options = normalizeOptions(args);
            const startedAt = Date.now();
            console.error(
                `[${SERVER_NAME}] request_id=${requestId} call_seq=${thisCallSeq} event=tool_start tool=${name} query_len=${query.length} output_mode=${options.outputMode} freshness_days=${options.freshnessDays ?? 'n/a'} max_sources=${options.maxSources} domains=${options.domains.length}`
            );

            try {
                const body = {
                    model: GROK_MODEL,
                    messages: [
                        { role: 'system', content: buildSystemPrompt(options) },
                        { role: 'user', content: buildUserPrompt(query, options) }
                    ],
                    stream: false
                };
                const headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`,
                    'X-Request-ID': requestId,
                };
                const { response, attempts, totalLatencyMs } = await postWithRetry({ requestId, body, headers });

                const reply = extractAssistantTextFromUpstreamData(response.data) || 'No response generated.';
                const parsed = extractJsonObject(reply);
                const structured = sanitizeStructuredResult(parsed, reply);
                const sourceCount = structured.sources.length;
                const endToEndMs = Date.now() - startedAt;
                runtimeStats.tool_calls_success += 1;
                console.error(
                    `[${SERVER_NAME}] request_id=${requestId} call_seq=${thisCallSeq} event=tool_ok attempts=${attempts} end_to_end_ms=${endToEndMs} upstream_total_ms=${totalLatencyMs} source_count=${sourceCount}`
                );
                debugLog('grok_web_search_ok', { requestId, call_seq: thisCallSeq, attempts, endToEndMs, sourceCount });

                return {
                    content: [{ type: 'text', text: structured.summary }],
                    structuredContent: {
                        request_id: requestId,
                        model: GROK_MODEL,
                        as_of: structured.as_of,
                        summary: structured.summary,
                        key_points: structured.key_points,
                        sources: structured.sources,
                        confidence: structured.confidence,
                        notes: structured.notes,
                        options: {
                            output_mode: options.outputMode,
                            language: options.language,
                            time_range: options.timeRange,
                            freshness_days: options.freshnessDays,
                            max_sources: options.maxSources,
                            domains_allowlist: options.domains,
                        },
                        metrics: {
                            call_seq: thisCallSeq,
                            end_to_end_ms: endToEndMs,
                            read_timeout_ms: READ_TIMEOUT_MS,
                            total_timeout_ms: TOTAL_TIMEOUT_MS,
                            attempts,
                            runtime_counters: {
                                tool_calls_total: runtimeStats.tool_calls_total,
                                tool_calls_success: runtimeStats.tool_calls_success,
                                tool_calls_error: runtimeStats.tool_calls_error,
                                upstream_attempts_total: runtimeStats.upstream_attempts_total,
                                upstream_failures_total: runtimeStats.upstream_failures_total,
                            }
                        }
                    }
                };
            } catch (error) {
                const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR';
                const status = typeof error?.status === 'number' ? error.status : undefined;
                const attempts = typeof error?.attempts === 'number' ? error.attempts : 1;
                const totalLatencyMs = typeof error?.totalLatencyMs === 'number' ? error.totalLatencyMs : (Date.now() - startedAt);
                runtimeStats.tool_calls_error += 1;
                runtimeStats.errors_by_code[code] = (runtimeStats.errors_by_code[code] || 0) + 1;
                const errorMsg = `Failed to execute grok_web_search [${code}]${status ? ` status=${status}` : ''}: ${error?.message || String(error)}`;
                console.error(
                    `[${SERVER_NAME}] request_id=${requestId} call_seq=${thisCallSeq} event=tool_err code=${code} status=${status ?? 'n/a'} attempts=${attempts} total_ms=${totalLatencyMs}`
                );
                debugLog('grok_web_search_err', { requestId, call_seq: thisCallSeq, code, status, attempts, totalLatencyMs, message: error?.message || String(error) });
                return {
                    content: [{ type: 'text', text: `Error: ${errorMsg}` }],
                    structuredContent: {
                        request_id: requestId,
                        error: { code, status, message: error?.message || String(error) },
                        metrics: {
                            call_seq: thisCallSeq,
                            attempts,
                            total_latency_ms: totalLatencyMs,
                            total_timeout_ms: TOTAL_TIMEOUT_MS,
                            runtime_counters: {
                                tool_calls_total: runtimeStats.tool_calls_total,
                                tool_calls_success: runtimeStats.tool_calls_success,
                                tool_calls_error: runtimeStats.tool_calls_error,
                                upstream_attempts_total: runtimeStats.upstream_attempts_total,
                                upstream_failures_total: runtimeStats.upstream_failures_total,
                            }
                        }
                    },
                    isError: true,
                };
            }
        }

        throw new Error(`Unknown tool: ${name}`);
    });

    return server;
}

async function startHttpServer(port) {
    const httpServer = createHttpServer(async (req, res) => {
        if (!req.url?.startsWith('/mcp')) {
            res.writeHead(404).end('Not found');
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
            return;
        }

        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const rawBody = Buffer.concat(chunks).toString('utf8');
                const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
                const server = createMcpServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true,
                });
                await server.connect(transport);
                await transport.handleRequest(req, res, parsedBody);
                res.on('close', () => {
                    transport.close().catch(() => {});
                    server.close().catch(() => {});
                });
            } catch (error) {
                debugLog('http_request_err', { message: error?.message || String(error), stack: error?.stack });
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: 'Internal server error' },
                        id: null,
                    }));
                }
            }
        });
    });

    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', resolve);
    });
    debugLog('http_listen', { port });
    console.error(`[${SERVER_NAME}] HTTP MCP listening on http://127.0.0.1:${port}/mcp`);
}

async function main() {
    debugLog('startup', {
        pid: process.pid,
        apiBaseUrl: API_BASE_URL,
        model: GROK_MODEL,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        readTimeoutMs: READ_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
    });
    const httpPort = Number.parseInt(process.env.GROK_MCP_HTTP_PORT || '', 10);
    if (Number.isFinite(httpPort) && httpPort > 0) {
        await startHttpServer(httpPort);
        return;
    }

    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${SERVER_NAME}] v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
});
