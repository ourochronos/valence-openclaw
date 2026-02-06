#!/bin/bash
# Add belief to Valence
# Usage: ./add.sh "Belief content" "domain1,domain2"

set -e

CONTENT="$1"
DOMAINS="$2"

if [ -z "$CONTENT" ]; then
    echo "Usage: $0 \"belief content\" \"domain1,domain2\"" >&2
    exit 1
fi

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
cd "$WORKSPACE"
source .venv/bin/activate

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

# Build domain args
DOMAIN_ARGS=""
if [ -n "$DOMAINS" ]; then
    IFS=',' read -ra DOMAIN_ARRAY <<< "$DOMAINS"
    for domain in "${DOMAIN_ARRAY[@]}"; do
        DOMAIN_ARGS="$DOMAIN_ARGS -d $domain"
    done
fi

valence add "$CONTENT" $DOMAIN_ARGS
