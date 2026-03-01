#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Always load .env from this script's directory, regardless of process cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const SERVER_NAME = 'grok-mcp-server';
const SERVER_VERSION = '1.2.0';

// ── Required configuration ──────────────────────────────────────────
const API_BASE_URL = process.env.GROK_API_URL;
const API_KEY = process.env.GROK_API_KEY || '';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-3';

// ── Optional tuning ─────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = Number(process.env.GROK_REQUEST_TIMEOUT_MS || 60000);
const MAX_RETRIES = Number(process.env.GROK_MAX_RETRIES || 2);
const BACKOFF_BASE_MS = Number(process.env.GROK_BACKOFF_BASE_MS || 800);
const CONNECT_TIMEOUT_MS = Number(process.env.GROK_CONNECT_TIMEOUT_MS || 10000);
const READ_TIMEOUT_MS = Number(process.env.GROK_READ_TIMEOUT_MS || REQUEST_TIMEOUT_MS);

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
    if (error.code === 'ECONNABORTED') {
        return { code: 'UPSTREAM_TIMEOUT', message: upstreamMessage, retryable: true, status };
    }
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
        return { code: 'NETWORK_ERROR', message: upstreamMessage, retryable: true, status };
    }
    return { code: 'UPSTREAM_4XX', message: upstreamMessage, retryable: false, status };
}

async function postWithRetry({ requestId, body, headers }) {
    let attempts = 0;
    const startedAt = Date.now();

    while (attempts <= MAX_RETRIES) {
        attempts += 1;
        runtimeStats.upstream_attempts_total += 1;
        const attemptStart = Date.now();
        try {
            const response = await axios.post(
                `${API_BASE_URL}/chat/completions`,
                body,
                {
                    headers,
                    timeout: READ_TIMEOUT_MS,
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
            await sleep(backoff);
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
        'You are a web-research assistant with real-time search capabilities.',
        'Search and synthesize the latest reliable information from the web and Twitter/X.',
        'Output MUST be valid JSON only, no markdown fences.',
        `Language for summary: ${language}.`,
        `Output mode: ${outputMode}.`,
        `Time range preference: ${timeRange}.`,
        `Freshness preference (days): ${freshnessDays ?? 'not specified'}.`,
        `Max sources requested: ${maxSources}.`,
        `Preferred domains: ${domains.length > 0 ? domains.join(', ') : 'none specified'}.`,
        'Return JSON object with keys:',
        '{"summary": string, "key_points": [{"point": string, "source_urls": string[]}], "sources": [{"title": string, "url": string, "publisher": string, "published_at": string, "relevance_note": string}], "confidence": number, "as_of": string, "notes": string }',
        'Rules:',
        '- summary must be concise and factual.',
        '- key_points should be concrete and each point should cite source_urls where possible.',
        '- sources should be deduplicated and include direct URLs.',
        '- confidence must be between 0 and 1.',
        '- as_of should be an ISO 8601 timestamp.',
        '- If uncertain, say so in notes and lower confidence.'
    ].join('\n');
}

function buildUserPrompt(query, { timeRange, freshnessDays, domains, maxSources }) {
    return [
        `User query: ${query}`,
        `Time range: ${timeRange}`,
        `Freshness days: ${freshnessDays ?? 'n/a'}`,
        `Domain allowlist: ${domains.length > 0 ? domains.join(', ') : 'n/a'}`,
        `Max sources: ${maxSources}`,
    ].join('\n');
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

// ── MCP Server ──────────────────────────────────────────────────────
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
    return {
        tools: [
            {
                name: 'grok_web_search',
                description: 'Search the web or Twitter(X) via Grok for real-time information and up-to-date events, with structured result and source URLs.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'The precise question or topic to search for'
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
        callSeq += 1;

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
            `[${SERVER_NAME}] request_id=${requestId} call_seq=${callSeq} event=tool_start tool=${name} query_len=${query.length} output_mode=${options.outputMode} freshness_days=${options.freshnessDays ?? 'n/a'} max_sources=${options.maxSources} domains=${options.domains.length}`
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

            const reply = response.data?.choices?.[0]?.message?.content || 'No response generated.';
            const parsed = extractJsonObject(reply);
            const structured = sanitizeStructuredResult(parsed, reply);
            const sourceCount = structured.sources.length;
            const endToEndMs = Date.now() - startedAt;
            runtimeStats.tool_calls_success += 1;
            console.error(
                `[${SERVER_NAME}] request_id=${requestId} call_seq=${callSeq} event=tool_ok attempts=${attempts} end_to_end_ms=${endToEndMs} upstream_total_ms=${totalLatencyMs} source_count=${sourceCount}`
            );

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
                        call_seq: callSeq,
                        end_to_end_ms: endToEndMs,
                        connect_timeout_ms: CONNECT_TIMEOUT_MS,
                        read_timeout_ms: READ_TIMEOUT_MS,
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
                `[${SERVER_NAME}] request_id=${requestId} call_seq=${callSeq} event=tool_err code=${code} status=${status ?? 'n/a'} attempts=${attempts} total_ms=${totalLatencyMs}`
            );
            return {
                content: [{ type: 'text', text: `Error: ${errorMsg}` }],
                structuredContent: {
                    request_id: requestId,
                    error: { code, status, message: error?.message || String(error) },
                    metrics: {
                        call_seq: callSeq,
                        attempts,
                        total_latency_ms: totalLatencyMs,
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

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${SERVER_NAME}] v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
});
