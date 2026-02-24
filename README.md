# Valence OpenClaw Plugin

Memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) that connects to [Valence v2](https://github.com/ourochronos/valence) — a knowledge substrate for AI agents.

## What it does

- **20 MCP tools** for sources, articles, knowledge search, contentions, admin, and memory
- **Auto-recall**: injects relevant knowledge into agent context before each run
- **Auto-capture**: extracts insights from conversations as memories (opt-in)
- **Session ingestion**: captures full conversation sessions as Valence sources, compiled into knowledge articles at compaction boundaries
- **Subagent tracking**: links child sessions to parents for full conversation trees

## Install

```bash
openclaw plugin install ourochronos/valence-openclaw
```

## Configure

In your OpenClaw plugin config, set:

| Option | Default | Description |
|--------|---------|-------------|
| `serverUrl` | `http://localhost:8420` | Valence server URL |
| `authToken` | — | Bearer token (`${VALENCE_AUTH_TOKEN}` for env var) |
| `autoRecall` | `true` | Inject relevant knowledge before agent runs |
| `autoCapture` | `false` | Extract insights from conversations |
| `sessionIngestion` | `true` | Capture sessions as Valence sources |
| `autoCompileOnFlush` | `true` | Compile articles on session flush |
| `recallMaxResults` | `5` | Max articles injected on auto-recall |
| `recallMinScore` | `0.3` | Min relevance score for auto-recall (reserved) |
| `staleSessionMinutes` | `30` | Stale session threshold (reserved) |
| `includeSystemMessages` | `true` | Capture system messages (reserved) |
| `inferenceEnabled` | `true` | Enable inference proxy endpoint for Valence compilation |
| `inferenceModel` | — | Model for compilation (e.g. `github-copilot/gpt-4.1-mini`) |

## Inference Endpoint

When `inferenceEnabled` is true, the plugin registers a `POST /valence/inference` endpoint on the OpenClaw gateway. This allows Valence to use OpenClaw's configured model providers for knowledge compilation without needing its own LLM credentials.

**Request:**
```json
{
  "prompt": "Compile this source into a knowledge article...",
  "system": "Optional system prompt override"
}
```

**Response:**
```json
{
  "text": "The compiled article content..."
}
```

**Configure Valence to use the callback:**
```bash
valence config inference callback --url http://localhost:3457/valence/inference
```
(Replace `3457` with your OpenClaw gateway port)

The endpoint supports OpenAI-compatible providers: `openai-completions`, `openai-responses`, `github-copilot`, and `ollama`.

## Requirements

- [Valence v2](https://github.com/ourochronos/valence) server running
- OpenClaw 2026.2.22+

## Tools

### Sources
- `source_ingest` — Ingest raw material (documents, conversations, web pages, code)
- `source_get` — Get source by ID
- `source_search` — Full-text search over sources

### Knowledge
- `knowledge_search` — Unified search across articles and sources

### Articles
- `article_get` — Get article with optional provenance
- `article_create` — Create article manually
- `article_compile` — Compile sources into article via LLM
- `article_update` — Update article content
- `article_split` — Split oversized article
- `article_merge` — Merge related articles

### Provenance
- `provenance_trace` — Trace claims back to sources

### Contentions
- `contention_list` — List contradictions in knowledge base
- `contention_resolve` — Resolve contentions

### Admin
- `admin_forget` — Permanently remove source or article
- `admin_stats` — System health and capacity stats
- `admin_maintenance` — Trigger maintenance operations

### Memory (agent-friendly)
- `memory_store` — Store a memory
- `memory_recall` — Search and recall memories
- `memory_status` — Memory system stats
- `memory_forget` — Soft-delete a memory

## Session Ingestion

When enabled, the plugin automatically:

1. **Creates sessions** on `session_start` hook
2. **Buffers messages** from `message_received` and `llm_output` hooks
3. **Flushes to sources** on `before_compaction` (serialized as markdown transcripts)
4. **Finalizes sessions** on `session_end` (flush + compile)
5. **Tracks subagents** linking child sessions to parents

All session data is stored server-side in Valence's PostgreSQL database. The plugin is a thin client.

## License

MIT — see [LICENSE](LICENSE)
