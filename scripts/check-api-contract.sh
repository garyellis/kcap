#!/bin/sh
set -eu

contract_tmp=$(mktemp -d)
trap 'rm -rf "$contract_tmp"' EXIT HUP INT TERM

uv run python scripts/export-openapi.py "$contract_tmp/openapi.json"
npm --prefix frontend exec openapi-ts -- \
  --input "$contract_tmp/openapi.json" \
  --output "$contract_tmp/generated" \
  --plugins @hey-api/typescript \
  --no-log-file \
  --silent

diff -ru frontend/src/generated "$contract_tmp/generated"
