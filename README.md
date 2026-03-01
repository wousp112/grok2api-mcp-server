# Grok MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that provides real-time web search capabilities powered by [Grok](https://x.ai/grok). Returns structured results with source URLs, confidence scores, key points, and multi-language support.

## How It Works

```
Claude / Cursor / etc.  ──MCP──>  grok-mcp-server  ──HTTP──>  grok2api  ──>  Grok
```

This server acts as an MCP bridge to a [grok2api](https://github.com/chenyme/grok2api)-compatible backend that exposes Grok's web search capabilities through an OpenAI-compatible API.

## Features

- **Real-time web & Twitter/X search** via Grok
- **Structured JSON output** — summary, key points with citations, source list, confidence score
- **Multiple output modes** — `brief`, `analyst`, `raw`
- **Multi-language support** — respond in any language
- **Time range filtering** — `24h`, `7d`, `30d`, `all`
- **Source freshness control** — prefer recent sources
- **Domain allowlisting** — restrict to trusted domains
- **Automatic retries** with exponential backoff
- **Runtime metrics** via `grok_stats` tool

## Prerequisites

You need a running [grok2api](https://github.com/chenyme/grok2api) instance (or any OpenAI-compatible API endpoint that provides Grok models with web search).

## Installation

### Option A: Global install (recommended for MCP clients)

```bash
git clone https://github.com/YOUR_USERNAME/grok-mcp-server.git
cd grok-mcp-server
cp .env.example .env
# Edit .env with your API URL and key
npm install
npm link
```

### Option B: Local install

```bash
git clone https://github.com/YOUR_USERNAME/grok-mcp-server.git
cd grok-mcp-server
cp .env.example .env
# Edit .env with your API URL and key
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROK_API_URL` | Yes | — | Your grok2api endpoint (e.g. `http://your-server:8000/v1`) |
| `GROK_API_KEY` | Yes | — | API key for authentication |
| `GROK_MODEL` | No | `grok-3` | Grok model name |
| `GROK_REQUEST_TIMEOUT_MS` | No | `60000` | Request timeout (ms) |
| `GROK_MAX_RETRIES` | No | `2` | Max retry attempts |
| `GROK_BACKOFF_BASE_MS` | No | `800` | Base backoff delay (ms) |
| `GROK_CONNECT_TIMEOUT_MS` | No | `10000` | Connection timeout (ms) |
| `GROK_READ_TIMEOUT_MS` | No | Same as request timeout | Read timeout (ms) |

## MCP Client Configuration

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "grok-mcp-server",
      "args": [],
      "env": {
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

### Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "grok-mcp-server",
      "args": []
    }
  }
}
```

### Cursor

Add to your Cursor MCP config (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "grok-mcp-server",
      "args": []
    }
  }
}
```

> **Note:** If you didn't `npm link`, use the full path: `"command": "/path/to/grok-mcp-server/index.js"`

## Tools

### `grok_web_search`

Search the web or Twitter/X via Grok with structured output.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | The question or topic to search for |
| `output_mode` | `brief` \| `analyst` \| `raw` | No | Response detail level (default: `analyst`) |
| `language` | string | No | Response language code (default: `en`) |
| `time_range` | `24h` \| `7d` \| `30d` \| `all` | No | Search lookback window (default: `all`) |
| `freshness_days` | integer | No | Prefer sources within N days |
| `max_sources` | integer | No | Max sources in output, 1-20 (default: `8`) |
| `domains_allowlist` | string[] | No | Preferred source domains (max 30) |

**Response structure:**

```json
{
  "summary": "Concise factual summary",
  "key_points": [
    {
      "point": "Key finding",
      "source_urls": ["https://..."]
    }
  ],
  "sources": [
    {
      "title": "Article Title",
      "url": "https://...",
      "publisher": "Publisher Name",
      "published_at": "2025-01-01T00:00:00Z",
      "relevance_note": "Why this source matters"
    }
  ],
  "confidence": 0.85,
  "as_of": "2025-01-01T12:00:00Z",
  "notes": "Additional context or caveats"
}
```

### `grok_stats`

Returns runtime metrics for the MCP server process (call counts, error distribution, uptime).

## Acknowledgements

- [grok2api](https://github.com/chenyme/grok2api) by chenyme — the backend that makes Grok accessible via OpenAI-compatible API
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic

## License

MIT
