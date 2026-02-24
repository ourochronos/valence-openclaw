# Valence OpenClaw Plugin v2 Rewrite Summary

## Changes Made

### Issue #3: Rewire hooks for v2 API
**Commit:** 646f137

- **Auto-recall**: Changed from `belief_query` → `memory_recall`
- **Auto-capture**: Changed from `belief_create` → `memory_store` 
- **Removed hooks**: session_start, session_end, message_received, message_sent (no server support)
- **MEMORY.md sync**: Rewrite to use `knowledge_search` instead of `listBeliefs`/`listPatterns`
- **Tools**: Replaced 58 aspirational v1 tools with 13 actual v2 tools:
  - Memory: memory_store, memory_recall, memory_status, memory_forget
  - Knowledge: knowledge_search  
  - Sources: source_ingest, source_search
  - Articles: article_get, article_compile, article_update
  - Contentions: contention_list, contention_resolve
  - Admin: admin_stats
- **Fallback**: Kept file-based memory_search/memory_get as DR fallback

### Issue #4: Fix config for v2
**Commit:** 5d568ff

- Removed from config: `sessionTracking`, `exchangeRecording`, `captureDomains`
- Kept defaults: `recallMaxResults=5`, `recallMinScore=0.3`
- Updated `openclaw.plugin.json` schema and uiHints
- Fixed help text: "beliefs" → "memories", "domain path" → "tags"

### Issue #5: Update SKILL.md and scripts
**Commit:** 36f8c4b

**SKILL.md:**
- Replaced 58 aspirational tools with 13 actual v2 tools
- Removed trust/federation/verification/reputation sections
- Updated architecture description (HTTP MCP)
- Fixed config table to match new schema
- Updated prerequisites (valence migrate/serve)

**Scripts:**
- `query.sh`: use `valence articles search`
- `add.sh`: use `valence sources ingest`
- `list.sh`: use `valence articles list`
- `stats.sh`: use bare `valence stats`

## Files Changed

```
plugin/client.ts            |   43 -
plugin/config.ts            |    4 -
plugin/index.ts             | 2123 +++++++++----------------------------------
plugin/openclaw.plugin.json |   28 +-
scripts/add.sh              |   24 +-
scripts/list.sh             |   12 +-
scripts/query.sh            |   17 +-
scripts/stats.sh            |    4 -
skill/SKILL.md              |   98 +-
9 files changed, 480 insertions(+), 1873 deletions(-)
```

**Net reduction:** 1,393 lines removed

## Verification

- TypeScript syntax check: ✓ PASS (node --check index.ts)
- All commits follow conventional commit format
- Not pushed (as requested)

## Branch

Branch: `v2-hooks`  
Worktree: `/tmp/valence-plugin-hooks`  
Base: `main`

## Next Steps

1. Test the plugin with a live Valence v2 server
2. Verify auto-recall/auto-capture work correctly
3. Test MEMORY.md sync
4. Merge to main when verified
