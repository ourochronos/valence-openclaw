#!/bin/bash
# Valence semantic search
# Usage: ./query.sh "search query" [limit]

set -e

QUERY="$1"
LIMIT="${2:-10}"

if [ -z "$QUERY" ]; then
    echo "Usage: $0 \"search query\" [limit]" >&2
    exit 1
fi

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

valence articles search "$QUERY" -n "$LIMIT"
