<div align="center">

# Grok MCP Server

**English** · [中文](./README.zh-CN.md)

</div>

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that provides real-time web search via [Grok](https://x.ai/grok). Returns structured results with source URLs, confidence scores, key points, and multi-language support.

## How It Works

```
Claude / Cursor / etc.  ──MCP──>  grok-mcp-server  ──HTTP──>  grok2api  ──>  Grok
```

This server bridges MCP clients to a [grok2api](https://github.com/chenyme/grok2api)-compatible backend, exposing Grok's real-time web search through an OpenAI-compatible API.

## Features

- **Real-time web & Twitter/X search** via Grok
- **Structured JSON output** — summary, key points with citations, source list, confidence score
- **Multiple output modes** — `brief`, `analyst`, `raw`
- **Multi-language support** — respond in any language
- **Time range filtering** — `24h`, `7d`, `30d`, `all`
- **Source freshness control** — prefer recent sources
- **Domain allowlist preference** — prioritize trusted domains (best-effort)
- **Automatic retries** with exponential backoff
- **Runtime metrics** via `grok_stats` tool

## Prerequisites

You need a running [grok2api](https://github.com/chenyme/grok2api) instance (or any OpenAI-compatible API endpoint backed by a Grok model with web search).

## Setting Up the grok2api Backend

> **It is strongly recommended to use a secondary/alt Grok account for this, not your primary account.**

### 1. Deploy grok2api

Choose the method that fits your environment:

<details>
<summary><b>VPS / Server (Docker Compose — recommended)</b></summary>

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose installed on your server.

```bash
git clone https://github.com/chenyme/grok2api
cd grok2api
docker compose up -d
```

The admin panel will be available at `http://your-server-ip:8000/admin` (default password: `grok2api`).

</details>

<details>
<summary><b>macOS (local)</b></summary>

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
# Install uv if you don't have it
brew install uv

# Clone and run
git clone https://github.com/chenyme/grok2api
cd grok2api
uv sync
uv run main.py
```

The admin panel will be at `http://localhost:8000/admin` (default password: `grok2api`).

</details>

<details>
<summary><b>Windows (local)</b></summary>

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```powershell
# Install uv (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Clone and run
git clone https://github.com/chenyme/grok2api
cd grok2api
uv sync
uv run main.py
```

The admin panel will be at `http://localhost:8000/admin` (default password: `grok2api`).

</details>

<details>
<summary><b>Linux (local, without Docker)</b></summary>

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Clone and run
git clone https://github.com/chenyme/grok2api
cd grok2api
uv sync
uv run main.py
```

The admin panel will be at `http://localhost:8000/admin` (default password: `grok2api`).

</details>

For cloud deployments (Vercel, Render), see the [grok2api README](https://github.com/chenyme/grok2api).

### 2. Get Your Grok Cookie

1. Log into [grok.com](https://grok.com) with your Grok account
2. Open browser DevTools (`F12` or `Cmd+Opt+I`)
3. Go to the **Application** tab
4. In the left sidebar, expand **Storage → Cookies**
5. Find the cookie named `sso` or `sso-rw`
6. Copy its value

### 3. Add Token to grok2api

1. Open the grok2api admin panel (`http://your-server:8000/admin`)
2. Click **Add** to add a new token
3. Paste the cookie value you just copied
4. Select your account type based on your Grok subscription:
   - **Basic** — 80 requests per 20 hours
   - **Super** — 140 requests per 2 hours

The `GROK_API_KEY` in your `.env` is the admin key configured in grok2api (the `app.app_key` value, default: `grok2api`).

## Installation

**Option A: Global install (recommended)**

```bash
git clone https://github.com/wousp112/grok-mcp-server.git
cd grok-mcp-server
cp .env.example .env
# Edit .env with your API URL and key
npm install
npm link
```

**Option B: Local install**

```bash
git clone https://github.com/wousp112/grok-mcp-server.git
cd grok-mcp-server
cp .env.example .env
# Edit .env with your API URL and key
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROK_API_URL` | **Yes** | — | Your grok2api endpoint (e.g. `http://your-server:8000/v1`) |
| `GROK_API_KEY` | **Yes** | — | API key for authentication |
| `GROK_MODEL` | No | `grok-3` | Grok model name |
| `GROK_REQUEST_TIMEOUT_MS` | No | `60000` | Request timeout (ms) |
| `GROK_MAX_RETRIES` | No | `2` | Max retry attempts |
| `GROK_BACKOFF_BASE_MS` | No | `800` | Base backoff delay for retries (ms) |
| `GROK_READ_TIMEOUT_MS` | No | Same as request timeout | Axios timeout (ms) |

## MCP Client Configuration

<details>
<summary><b>Claude Desktop</b></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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
</details>

<details>
<summary><b>Claude Code</b></summary>

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
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json`:

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
</details>

> **Note:** If you skipped `npm link`, use the full path instead: `"command": "/path/to/grok-mcp-server/index.js"`

## Tools

### `grok_web_search`

Search the web or Twitter/X via Grok with structured output.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | **Yes** | — | The question or topic to search for |
| `output_mode` | `brief`\|`analyst`\|`raw` | No | `analyst` | Response detail level |
| `language` | string | No | `en` | Response language code |
| `time_range` | `24h`\|`7d`\|`30d`\|`all` | No | `all` | Search lookback window |
| `freshness_days` | integer | No | — | Prefer sources within N days |
| `max_sources` | integer | No | `8` | Max sources in output (1–20) |
| `domains_allowlist` | string[] | No | — | Preferred source domains, best-effort (max 30) |

**Response structure:**

```json
{
  "summary": "Concise factual summary",
  "key_points": [
    { "point": "Key finding", "source_urls": ["https://..."] }
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

Returns runtime metrics: call counts, error distribution, uptime.

## Acknowledgements

- [grok2api](https://github.com/chenyme/grok2api) by chenyme — the backend that makes Grok accessible via OpenAI-compatible API

## License

MIT
