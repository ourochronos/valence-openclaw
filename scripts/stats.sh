#!/bin/bash
# Valence database statistics
# Usage: ./stats.sh

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
cd "$WORKSPACE"
source .venv/bin/activate

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

valence stats
