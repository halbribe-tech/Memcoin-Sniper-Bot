#!/bin/sh
# Records launches, migrations and PumpSwap trades until stopped (Ctrl+C), restarting
# the recorder whenever the public stream goes quiet. Keeps the Mac awake meanwhile.
#   research/record.sh [out.jsonl] [public|helius]
cd "$(dirname "$0")/.." || exit 1
OUT="${1:-research/migrations.jsonl}"
SOURCE="${2:-public}"
trap 'exit 0' INT TERM
while true; do
  caffeinate -ims ./apps/engine/node_modules/.bin/tsx research/recorder.ts "$OUT" "$SOURCE"
  echo "$(date) recorder exited — restarting in 5s"
  sleep 5
done
