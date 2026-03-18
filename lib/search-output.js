import { extractAssistantTextFromUpstreamData } from './upstream-response.js';

function extractJsonCandidate(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        // keep trying
    }

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
        try {
            return JSON.parse(fenceMatch[1].trim());
        } catch {
            // keep trying
        }
    }

    const firstObject = trimmed.indexOf('{');
    const lastObject = trimmed.lastIndexOf('}');
    if (firstObject >= 0 && lastObject > firstObject) {
        try {
            return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
        } catch {
            // keep trying
        }
    }

    const firstArray = trimmed.indexOf('[');
    const lastArray = trimmed.lastIndexOf(']');
    if (firstArray >= 0 && lastArray > firstArray) {
        try {
            return JSON.parse(trimmed.slice(firstArray, lastArray + 1));
        } catch {
            return null;
        }
    }

    return null;
}

function uniqUrls(values) {
    const urls = [];
    const seen = new Set();

    for (const value of values) {
        if (typeof value !== 'string') continue;
        const url = value.trim();
        if (!/^https?:\/\//i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
    }

    return urls;
}

export function extractSourceUrlsFromAssistantText(text) {
    const parsed = extractJsonCandidate(text);
    if (Array.isArray(parsed)) {
        return uniqUrls(parsed);
    }

    if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.sources)) {
            return uniqUrls(parsed.sources.map((item) => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object') return item.url;
                return '';
            }));
        }
    }

    const matched = String(text || '').match(/https?:\/\/[^\s"'`<>)\]]+/g) || [];
    return uniqUrls(matched);
}

export function parseCliSearchResult(upstreamData) {
    const assistantText = extractAssistantTextFromUpstreamData(upstreamData);
    const sources = extractSourceUrlsFromAssistantText(assistantText);

    return {
        ok: sources.length > 0,
        assistant_text: assistantText,
        sources,
        first_source_url: sources[0] || '',
    };
}
