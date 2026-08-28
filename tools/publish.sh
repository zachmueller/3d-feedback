#!/usr/bin/env bash
#
# Publish a GLB as the next revision of a project and print its share URL.
#
#   tools/publish.sh model.glb --project towel-clip \
#       [--title "Towel clip"] [--notes "raised the clip angle 5°"] \
#       [--profile my-aws-profile] [--api-url https://…] [--site-url https://…] \
#       [--region us-east-1] [--timeout 120] [--revision 4] [--force] \
#       [--no-verify] [--quiet]
#
# The URL is printed on stdout as the last line and nothing else goes there, so a
# workflow can capture it directly:
#
#   URL=$(tools/publish.sh model.glb --project towel-clip --quiet)
#
# This is a wrapper. The publishing itself lives in tools/mcp/publish.ts, which the
# MCP server calls in-process — one implementation of reserve → upload → wait →
# verify, rather than a shell script and a server that have to agree. That is also
# why bash, jq, curl and the AWS CLI are no longer required: credentials are
# resolved and the request is signed by the AWS SDK. `--help` lists every flag.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ -d "$ROOT/node_modules" ]] || {
  echo "error: run npm install first — publishing runs from this checkout's TypeScript" >&2
  exit 1
}

exec "$ROOT/node_modules/.bin/ts-node" \
  --prefer-ts-exts \
  --project "$ROOT/tools/mcp/tsconfig.json" \
  "$ROOT/tools/mcp/cli.ts" \
  "$@"
