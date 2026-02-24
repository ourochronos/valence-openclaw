#!/bin/bash
# Valence database statistics
# Usage: ./stats.sh

set -e

export VKB_DB_PORT=5433
export VKB_DB_PASSWORD=valence

valence stats
