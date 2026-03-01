<div align="center">

# Grok MCP Server

[English](./README.md) · **中文**

</div>

基于 [MCP（模型上下文协议）](https://modelcontextprotocol.io/) 的实时网络搜索服务器，由 [Grok](https://x.ai/grok) 提供支持。返回结构化结果，包含来源 URL、置信度评分、关键要点，支持多语言输出。

## 工作原理

```
Claude / Cursor 等  ──MCP──>  grok-mcp-server  ──HTTP──>  grok2api  ──>  Grok
```

本服务器将 MCP 客户端桥接到兼容 [grok2api](https://github.com/chenyme/grok2api) 的后端，通过 OpenAI 兼容接口提供 Grok 的实时网络搜索能力。

## 功能特性

- **实时网络 & Twitter/X 搜索** — 由 Grok 驱动
- **结构化 JSON 输出** — 摘要、带引用的关键要点、来源列表、置信度评分
- **多种输出模式** — `brief`（简洁）、`analyst`（深度分析）、`raw`（原始上下文）
- **多语言支持** — 可用任意语言响应
- **时间范围过滤** — `24h`、`7d`、`30d`、`all`
- **来源新鲜度控制** — 优先显示近期内容
- **域名白名单偏好** — 优先可信来源（best-effort）
- **自动重试** — 指数退避策略
- **运行时指标** — 通过 `grok_stats` 工具查看

## 前置条件

需要一个运行中的 [grok2api](https://github.com/chenyme/grok2api) 实例（或任何支持 Grok 网络搜索的 OpenAI 兼容 API 端点）。

## 配置 grok2api 后端

> **强烈建议使用小号操作，不要使用主账号。**

### 1. 部署 grok2api

根据你的环境选择合适的部署方式：

<details>
<summary><b>VPS / 服务器（Docker Compose — 推荐）</b></summary>

需要在服务器上安装 [Docker](https://docs.docker.com/get-docker/) 和 Docker Compose。

```bash
git clone https://github.com/chenyme/grok2api
cd grok2api
docker compose up -d
```

管理面板地址：`http://你的服务器IP:8000/admin`（默认密码：`grok2api`）。

</details>

<details>
<summary><b>macOS（本地运行）</b></summary>

需要 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。

```bash
# 安装 uv（如果还没装）
brew install uv

# 克隆并运行
git clone https://github.com/chenyme/grok2api
cd grok2api
uv sync
uv run main.py
```

管理面板地址：`http://localhost:8000/admin`（默认密码：`grok2api`）。

</details>

<details>
<summary><b>Windows（本地运行）</b></summary>

需要 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。

```powershell
# 安装 uv（PowerShell）
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 克隆并运行
git clone https://github.com/chenyme/grok2api
cd grok2api
uv sync
uv run main.py
```

管理面板地址：`http://localhost:8000/admin`（默认密码：`grok2api`）。

</details>

<details>
<summary><b>Linux（本地运行，不用 Docker）</b></summary>

需要 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。

```bash
# 安装 uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# 克隆并运行
git clone https://github.com/chenyme/grok2api
cd grok2api
uv sync
uv run main.py
```

管理面板地址：`http://localhost:8000/admin`（默认密码：`grok2api`）。

</details>

云部署方式（Vercel、Render）请参考 [grok2api README](https://github.com/chenyme/grok2api)。

### 2. 获取 Grok Cookie

1. 用你的 Grok 账号登录 [grok.com](https://grok.com)
2. 打开浏览器开发者工具（`F12` 或 `Cmd+Opt+I`）
3. 切换到 **Application** 选项卡
4. 在左侧栏展开 **Storage → Cookies**
5. 找到名为 `sso` 或 `sso-rw` 的 Cookie
6. 复制其值

### 3. 在 grok2api 中添加 Token

1. 打开 grok2api 管理面板（`http://your-server:8000/admin`）
2. 点击 **添加** 按钮
3. 粘贴刚才复制的 Cookie 值
4. 根据你的 Grok 订阅类型选择账户类型：
   - **Basic** — 每 20 小时 80 次请求
   - **Super** — 每 2 小时 140 次请求

`.env` 中的 `GROK_API_KEY` 是 grok2api 的管理密钥（即 `app.app_key` 的值，默认为 `grok2api`）。

## 安装

**方案 A：全局安装（推荐）**

```bash
git clone https://github.com/wousp112/grok-mcp-server.git
cd grok-mcp-server
cp .env.example .env
# 编辑 .env，填入你的 API 地址和密钥
npm install
npm link
```

**方案 B：本地安装**

```bash
git clone https://github.com/wousp112/grok-mcp-server.git
cd grok-mcp-server
cp .env.example .env
# 编辑 .env，填入你的 API 地址和密钥
npm install
```

## 配置

将 `.env.example` 复制为 `.env` 并填写配置：

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `GROK_API_URL` | **是** | — | grok2api 端点地址（如 `http://your-server:8000/v1`） |
| `GROK_API_KEY` | **是** | — | 身份验证 API 密钥 |
| `GROK_MODEL` | 否 | `grok-3` | Grok 模型名称 |
| `GROK_REQUEST_TIMEOUT_MS` | 否 | `60000` | 请求超时时间（毫秒） |
| `GROK_MAX_RETRIES` | 否 | `2` | 最大重试次数 |
| `GROK_BACKOFF_BASE_MS` | 否 | `800` | 重试基础退避时间（毫秒） |
| `GROK_READ_TIMEOUT_MS` | 否 | 同请求超时 | Axios 超时时间（毫秒） |

## MCP 客户端配置

<details>
<summary><b>Claude Desktop</b></summary>

添加到 `~/Library/Application Support/Claude/claude_desktop_config.json`：

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

添加到 `.cursor/mcp.json`：

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

> **注意：** 如果跳过了 `npm link`，请使用完整路径：`"command": "/path/to/grok-mcp-server/index.js"`

## 工具说明

### `grok_web_search`

通过 Grok 搜索网络或 Twitter/X，返回结构化结果。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | **是** | — | 搜索问题或主题 |
| `output_mode` | `brief`\|`analyst`\|`raw` | 否 | `analyst` | 输出详细程度 |
| `language` | string | 否 | `en` | 响应语言代码（如 `zh`、`en`） |
| `time_range` | `24h`\|`7d`\|`30d`\|`all` | 否 | `all` | 搜索时间范围 |
| `freshness_days` | integer | 否 | — | 优先显示 N 天内的来源 |
| `max_sources` | integer | 否 | `8` | 最多返回来源数量（1–20） |
| `domains_allowlist` | string[] | 否 | — | 偏好域名列表（best-effort，最多 30 个） |

**响应结构：**

```json
{
  "summary": "简洁的事实性摘要",
  "key_points": [
    { "point": "关键发现", "source_urls": ["https://..."] }
  ],
  "sources": [
    {
      "title": "文章标题",
      "url": "https://...",
      "publisher": "发布方",
      "published_at": "2025-01-01T00:00:00Z",
      "relevance_note": "为何此来源相关"
    }
  ],
  "confidence": 0.85,
  "as_of": "2025-01-01T12:00:00Z",
  "notes": "补充说明或注意事项"
}
```

### `grok_stats`

返回运行时指标：调用次数、错误分布、运行时长。

## 致谢

- [grok2api](https://github.com/chenyme/grok2api) by chenyme — 通过 OpenAI 兼容接口提供 Grok 访问能力的后端项目

## 许可证

MIT
