# Valence CLI Reference

## Environment Setup

```bash
export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence
cd ~/.openclaw/workspace && source .venv/bin/activate
```

## Commands

### valence query

Semantic search across beliefs.

```bash
valence query "search terms" [options]
```

Options:
- `-n, --limit N` — Max results (default: 10)
- `-d, --domain DOMAIN` — Filter by domain
- `--explain` — Show ranking breakdown

### valence add

Add a new belief.

```bash
valence add "Belief content" [options]
```

Options:
- `-d, --domain DOMAIN` — Add domain tag (repeatable)
- `-c, --confidence JSON` — Set confidence dimensions

Confidence example:
```bash
valence add "Fact" -c '{"source_reliability": 0.9, "method_quality": 0.8}'
```

### valence list

List recent beliefs.

```bash
valence list [options]
```

Options:
- `-n, --limit N` — Number to show (default: 10)
- `-d, --domain DOMAIN` — Filter by domain

### valence stats

Database statistics.

```bash
valence stats
```

### valence conflicts

Detect contradicting beliefs.

```bash
valence conflicts
```

### valence trust

Trust network management.

```bash
valence trust list                    # List trust relationships
valence trust add ENTITY --topic T --level 0.8  # Add trust
```

## Confidence Dimensions

| Dimension | Default | Meaning |
|-----------|---------|---------|
| source_reliability | 0.5 | Origin trustworthiness |
| method_quality | 0.3 | How knowledge was derived |
| internal_consistency | 0.7 | Contradiction with other beliefs |
| temporal_freshness | 1.0 | Still valid? |
| corroboration | 0.2 | Multiple sources agree? |
| domain_applicability | 0.6 | Context relevance |

Overall confidence = geometric mean of all dimensions.
