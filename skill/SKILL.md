# Valence Memory

Persistent knowledge substrate for OpenClaw. Replaces flat-file memory with a structured knowledge system featuring semantic search, automatic compilation, and organic forgetting.

## What It Does

Valence gives your agent **real memory** — not conversation logs, but a structured knowledge base that grows smarter over time:

- **Memory Management** — Store and recall memories with semantic search, importance scoring, and optional tags
- **Auto-recall** — Relevant memories are injected into context before the agent runs, no manual searching needed
- **Auto-capture** — Insights from conversations are extracted as memories automatically
- **Knowledge Articles** — Raw sources are automatically compiled into coherent, right-sized knowledge articles via LLM summarization
- **Contention Detection** — Contradictions between sources and articles are surfaced for resolution
- **Organic Forgetting** — Bounded-memory capacity with usage-based eviction keeps the knowledge base focused
- **MEMORY.md sync** — Disaster-recovery fallback so you lose nothing if you uninstall

## Prerequisites

Valence v2 requires a running server with PostgreSQL + pgvector:

```bash
# Install Valence
pip install ourochronos-valence

# Start PostgreSQL with pgvector (Docker is easiest)
docker run -d --name valence-db \
  -e POSTGRES_DB=valence \
  -e POSTGRES_USER=valence \
  -e POSTGRES_PASSWORD=valence \
  -p 5432:5432 \
  pgvector/pgvector:pg17

# Run migrations
valence migrate up

# Start the server
valence serve
```

The server runs at `http://127.0.0.1:8420` by default.

## Install the Plugin

```bash
openclaw plugins install @ourochronos/memory-valence
```

## Configure

Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-valence"
    },
    "entries": {
      "memory-valence": {
        "enabled": true,
        "config": {
          "serverUrl": "http://127.0.0.1:8420",
          "autoRecall": true,
          "autoCapture": true,
          "memoryMdSync": true
        }
      }
    }
  }
}
```

Or use the OpenClaw Control UI to configure via the web interface.

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `serverUrl` | `http://127.0.0.1:8420` | Valence server URL |
| `authToken` | — | Bearer token (or set `VALENCE_AUTH_TOKEN` env var) |
| `autoRecall` | `true` | Inject relevant memories before agent runs |
| `autoCapture` | `true` | Extract insights from conversations |
| `recallMaxResults` | `5` | Max memories injected on auto-recall |
| `recallMinScore` | `0.3` | Minimum relevance score for recall (0-1) |
| `captureDomains` | `["conversations"]` | Default tags for auto-captured memories |
| `memoryMdSync` | `true` | Sync articles to MEMORY.md as DR fallback |
| `memoryMdPath` | `MEMORY.md` | Path for MEMORY.md file |

## Agent Tools

The plugin exposes 13 v2 tools organized by category:

### Memory Management (most commonly used)
- `memory_store` — Store a memory for later recall
- `memory_recall` — Search and recall memories (used by auto-recall)
- `memory_status` — Get memory system statistics
- `memory_forget` — Mark a memory as forgotten (soft delete)

### Knowledge Search
- `knowledge_search` — Unified search across articles and sources (ranked by relevance, confidence, freshness)

### Source Management
- `source_ingest` — Ingest a new source (document, conversation, web, code, observation, tool output, user input)
- `source_search` — Full-text search over sources

### Article Management
- `article_get` — Get an article by ID, optionally with provenance
- `article_compile` — Compile sources into a new article via LLM
- `article_update` — Update an article's content

### Contention Resolution
- `contention_list` — List active contradictions between sources and articles
- `contention_resolve` — Resolve a contention (supersede_a, supersede_b, accept_both, dismiss)

### System Administration
- `admin_stats` — Health and capacity statistics

### File-based Fallback
- `memory_search` / `memory_get` — Search and read MEMORY.md (DR fallback when server is unreachable)

## How It Works

1. **On each agent turn**, auto-recall searches Valence for memories relevant to the current conversation and injects them as context
2. **During conversations**, the agent uses memory_store to capture decisions, preferences, and insights
3. **After conversations**, auto-capture extracts any uncaptured insights
4. **Sources compile into articles** automatically based on usage patterns and semantic clustering
5. **Over time**, the knowledge base self-organizes through usage-based scoring and organic forgetting
6. **MEMORY.md** is kept in sync as a human-readable snapshot and safety net

## Architecture

```
OpenClaw Agent
    ↕ (plugin tools + hooks)
memory-valence plugin
    ↕ (HTTP MCP)
Valence Server (http://127.0.0.1:8420)
    ↕ (SQL + pgvector)
PostgreSQL + pgvector
```

The plugin is a thin HTTP client. All intelligence lives in the Valence server — embeddings, article compilation, usage scoring, contention detection, and organic forgetting.

## Links

- **Valence**: [github.com/ourochronos/valence](https://github.com/ourochronos/valence) | [PyPI](https://pypi.org/project/ourochronos-valence/)
- **Plugin**: [github.com/ourochronos/valence-openclaw](https://github.com/ourochronos/valence-openclaw) | [npm](https://www.npmjs.com/package/@ourochronos/memory-valence)
- **Issues**: [github.com/ourochronos/valence/issues](https://github.com/ourochronos/valence/issues)
