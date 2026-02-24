#!/bin/bash
# Add source to Valence
# Usage: ./add.sh "Source content" "document|conversation|web|code|observation|tool_output|user_input"

set -e

CONTENT="$1"
TYPE="${2:-observation}"

if [ -z "$CONTENT" ]; then
    echo "Usage: $0 \"source content\" [type]" >&2
    echo "Type: document, conversation, web, code, observation, tool_output, user_input" >&2
    exit 1
fi

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

valence sources ingest --type "$TYPE" --content "$CONTENT"
