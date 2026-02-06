#!/bin/bash
# List recent Valence beliefs
# Usage: ./list.sh [count]

set -e

COUNT="${1:-10}"

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
cd "$WORKSPACE"
source .venv/bin/activate

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

valence list -n "$COUNT"
