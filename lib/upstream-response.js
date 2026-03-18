function stripThinkBlocks(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractFromSsePayload(payload) {
    const chunks = [];
    const events = String(payload || '').split(/\r?\n\r?\n/);

    for (const event of events) {
        if (!event.trim()) continue;

        const dataLines = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) continue;

        const data = dataLines.join('\n');
        if (!data || data === '[DONE]') continue;

        try {
            const parsed = JSON.parse(data);
            const choice = parsed?.choices?.[0];
            const content = choice?.delta?.content ?? choice?.message?.content;
            if (typeof content === 'string' && content.length > 0) {
                chunks.push(content);
            }
        } catch {
            // Ignore malformed event fragments and keep the rest.
        }
    }

    return stripThinkBlocks(chunks.join(''));
}

export function extractAssistantTextFromUpstreamData(data) {
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (!trimmed) return '';

        try {
            return extractAssistantTextFromUpstreamData(JSON.parse(trimmed));
        } catch {
            return extractFromSsePayload(trimmed);
        }
    }

    if (Buffer.isBuffer(data)) {
        return extractFromSsePayload(data.toString('utf8'));
    }

    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.delta?.content;
    if (typeof content === 'string') {
        return stripThinkBlocks(content);
    }

    return '';
}
