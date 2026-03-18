#!/usr/bin/env node

import axios from 'axios';
import * as dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCliSearchResult } from '../lib/search-output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

function usage() {
    console.error('Usage: grok-search-cli --query "..." [--max-sources 3] [--timeout-sec 180] [--retries 1]');
}

function parseArgs(argv) {
    const result = {
        query: '',
        maxSources: 3,
        timeoutSec: 180,
        retries: 1,
        raw: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--query' || arg === '-q') {
            result.query = argv[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--max-sources') {
            result.maxSources = Number.parseInt(argv[i + 1] || '3', 10) || 3;
            i += 1;
            continue;
        }
        if (arg === '--timeout-sec') {
            result.timeoutSec = Number.parseInt(argv[i + 1] || '180', 10) || 180;
            i += 1;
            continue;
        }
        if (arg === '--retries') {
            result.retries = Number.parseInt(argv[i + 1] || '1', 10) || 1;
            i += 1;
            continue;
        }
        if (arg === '--raw') {
            result.raw = true;
        }
    }

    return result;
}

function isRetryableError(error) {
    if (!error) return false;
    if (error.code === 'ECONNABORTED') return true;
    const message = String(error.message || '').toLowerCase();
    if (message.includes('timeout')) return true;
    const status = error?.response?.status;
    return typeof status === 'number' && status >= 500;
}

async function requestSearch({ apiUrl, apiKey, model, query, timeoutSec }) {
    return axios.post(
        `${apiUrl}/chat/completions`,
        {
            model,
            stream: false,
            temperature: 0,
            max_tokens: 120,
            messages: [
                {
                    role: 'system',
                    content: 'Search X/Twitter and the web. Return compact JSON only: {"sources":["url"]}. Use 1 to 3 URLs. No prose.',
                },
                {
                    role: 'user',
                    content: query,
                },
            ],
        },
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            timeout: timeoutSec * 1000,
        }
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.query) {
        usage();
        process.exit(2);
    }

    const apiUrl = process.env.GROK_API_URL;
    const apiKey = process.env.GROK_API_KEY;
    const model = process.env.GROK_MODEL || 'grok-4.20-beta';

    if (!apiUrl || !apiKey) {
        console.error('Missing GROK_API_URL or GROK_API_KEY');
        process.exit(2);
    }

    const startedAt = Date.now();
    let response;
    let attempts = 0;
    let lastError;

    for (let attempt = 1; attempt <= args.retries + 1; attempt += 1) {
        attempts = attempt;
        const timeoutSec = args.timeoutSec + ((attempt - 1) * 60);
        try {
            response = await requestSearch({
                apiUrl,
                apiKey,
                model,
                query: args.query,
                timeoutSec,
            });
            break;
        } catch (error) {
            lastError = error;
            if (attempt > args.retries || !isRetryableError(error)) {
                throw error;
            }
            console.error(`Attempt ${attempt} failed (${error.message || 'unknown error'}); retrying with timeout ${timeoutSec + 60}s...`);
        }
    }

    if (!response) {
        throw lastError || new Error('Search request failed');
    }

    const parsed = parseCliSearchResult(response.data);
    const trimmedSources = parsed.sources.slice(0, Math.max(1, args.maxSources));
    const result = {
        ok: trimmedSources.length > 0,
        model,
        attempts,
        elapsed_ms: Date.now() - startedAt,
        query: args.query,
        first_source_url: trimmedSources[0] || '',
        sources: trimmedSources,
        assistant_text: args.raw ? parsed.assistant_text : undefined,
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error?.response?.data || error?.message || String(error));
    process.exit(1);
});
