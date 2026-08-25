#!/usr/bin/env bash
#
# Publish a GLB as the next revision of a project and print its share URL.
#
#   tools/publish.sh model.glb --project towel-clip \
#       [--title "Towel clip"] [--notes "raised the clip angle 5°"] \
#       [--profile my-aws-profile] [--api-url https://…] [--quiet]
#
# The URL is printed on stdout as the last line and nothing else goes there, so a
# workflow can capture it directly:
#
#   URL=$(tools/publish.sh model.glb --project towel-clip --quiet)
#
# Steps: SigV4-signed POST /publish reserves the revision and returns a presigned
# PUT; the file goes straight to S3; then status/<project>/<rev>.json is polled
# until the processor marks it ready.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
log() { [[ -n "${QUIET:-}" ]] || echo "$*" >&2; }

FILE=""
PROJECT=""
TITLE=""
NOTES=""
PROFILE="${AWS_PROFILE:-}"
API_URL="${THREED_API_URL:-}"
SITE_URL="${THREED_SITE_URL:-}"
REGION="${AWS_REGION:-us-east-1}"
QUIET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --title)   TITLE="${2:-}";   shift 2 ;;
    --notes)   NOTES="${2:-}";   shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --site-url) SITE_URL="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}";  shift 2 ;;
    --quiet|-q) QUIET=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) die "unknown flag $1" ;;
    *) [[ -z "$FILE" ]] || die "only one file at a time"; FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || die "pass the .glb file to publish"
[[ -f "$FILE" ]] || die "no such file: $FILE"
[[ -n "$PROJECT" ]] || die "--project is required"

command -v jq >/dev/null || die "jq is required (brew install jq)"
command -v aws >/dev/null || die "the AWS CLI v2 is required"

# curl gained --aws-sigv4 in 7.75; macOS ships 8.x, but check rather than emit a
# confusing signature error.
curl --help all 2>/dev/null | grep -q -- '--aws-sigv4' \
  || die "this curl has no --aws-sigv4 support (need curl >= 7.75)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUTS="$ROOT/cdk-outputs.json"

# Endpoints come from the flag, then the environment, then the deploy outputs.
read_output() {
  [[ -f "$OUTPUTS" ]] || return 0
  jq -r --arg k "$1" '..|objects|select(has($k))|.[$k]' "$OUTPUTS" 2>/dev/null | head -1
}
[[ -n "$API_URL" ]] || API_URL="$(read_output ApiUrl)"
[[ -n "$SITE_URL" ]] || SITE_URL="$(read_output SiteUrl)"
[[ -n "$API_URL" ]] || die "no API URL: pass --api-url, set THREED_API_URL, or deploy with --outputs-file cdk-outputs.json"
API_URL="${API_URL%/}"
SITE_URL="${SITE_URL%/}"

# Export static credentials for curl to sign with. `export-credentials` resolves
# SSO / assumed-role / profile chains the same way the CLI itself does.
if [[ -n "$PROFILE" ]]; then
  eval "$(aws configure export-credentials --profile "$PROFILE" --format env)"
else
  eval "$(aws configure export-credentials --format env)"
fi
[[ -n "${AWS_ACCESS_KEY_ID:-}" ]] || die "could not resolve AWS credentials"

SIGV4_ARGS=(--aws-sigv4 "aws:amz:${REGION}:execute-api"
            --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
[[ -z "${AWS_SESSION_TOKEN:-}" ]] || SIGV4_ARGS+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")

# 1. Reserve the revision.
log "reserving a revision of $PROJECT…"
REQUEST=$(jq -n \
  --arg project "$PROJECT" \
  --arg filename "$(basename "$FILE")" \
  --arg title "$TITLE" \
  --arg notes "$NOTES" \
  '{project: $project, filename: $filename}
   + (if $title == "" then {} else {title: $title} end)
   + (if $notes == "" then {} else {notes: $notes} end)')

RESPONSE=$(curl -sS -X POST "$API_URL/publish" \
  "${SIGV4_ARGS[@]}" \
  -H 'content-type: application/json' \
  -d "$REQUEST")

if ! jq -e '.revision' >/dev/null 2>&1 <<<"$RESPONSE"; then
  die "publish failed: $(jq -r '.error // .message // .' <<<"$RESPONSE" 2>/dev/null || echo "$RESPONSE")"
fi

REVISION=$(jq -r '.revision' <<<"$RESPONSE")
URL=$(jq -r '.url' <<<"$RESPONSE")
UPLOAD_URL=$(jq -r '.uploadUrl' <<<"$RESPONSE")
[[ -n "$SITE_URL" ]] || SITE_URL="$(sed -E 's#(https://[^/]+).*#\1#' <<<"$URL")"

# 2. Upload the bytes. The presigned PUT does not pin a Content-Type, so curl's
#    default is fine; the processor sets model/gltf-binary when it copies.
log "uploading $(basename "$FILE") ($(wc -c <"$FILE" | tr -d ' ') bytes) as revision $REVISION…"
UPLOAD_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --upload-file "$FILE" "$UPLOAD_URL")
[[ "$UPLOAD_STATUS" == "200" ]] || die "upload failed with HTTP $UPLOAD_STATUS"

# 3. Wait for the processor.
log "waiting for processing…"
STATUS_URL="$SITE_URL/status/$PROJECT/$REVISION.json"
DEADLINE=$(( $(date +%s) + 120 ))
while :; do
  sleep 2
  BODY=$(curl -sS -H 'cache-control: no-cache' "$STATUS_URL" 2>/dev/null || true)
  STATE=$(jq -r '.status // empty' <<<"$BODY" 2>/dev/null || true)
  case "$STATE" in
    ready) break ;;
    error) die "processing failed: $(jq -r '.error' <<<"$BODY")" ;;
  esac
  [[ $(date +%s) -lt $DEADLINE ]] || die "timed out waiting for processing ($STATUS_URL)"
done

log "published $PROJECT revision $REVISION"
echo "$URL"
