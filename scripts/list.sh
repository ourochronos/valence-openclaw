#!/bin/bash
# List knowledge articles
# Usage: ./list.sh [limit]

set -e

LIMIT="${1:-20}"

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

valence articles list -n "$LIMIT"
