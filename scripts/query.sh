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

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
cd "$WORKSPACE"
source .venv/bin/activate

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence
export TRANSFORMERS_VERBOSITY=error
export HF_HUB_DISABLE_PROGRESS_BARS=1
export TOKENIZERS_PARALLELISM=false

# Run with reduced verbosity
python -c "
import logging
logging.disable(logging.INFO)
import warnings
warnings.filterwarnings('ignore')
" 2>/dev/null

valence query "$QUERY" -n "$LIMIT" 2>&1 | grep -Ev "^(INFO:|Loading weights:|Batches:|WARNING.*HF|BertModel LOAD|Key.*Status|---.*---|\[3m|UNEXPECTED)"
