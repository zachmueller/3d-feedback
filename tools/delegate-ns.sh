#!/usr/bin/env bash
#
# One-time DNS delegation: point the parent zone at the subdomain zone this stack
# created.
#
#   tools/delegate-ns.sh --parent-profile domains [--parent zach.nz] \
#       [--subdomain 3d.zach.nz] [--profile deploy-profile] [--dry-run]
#
# The subdomain's hosted zone lives in the account this stack deploys to, while
# the parent zone lives in a separate `domains` account, so the NS record that
# ties them together cannot be created by CloudFormation. This reads the zone's
# name servers from the deploy account and UPSERTs them into the parent zone.
#
# Run it while `cdk deploy` is waiting on certificate validation: ACM cannot see
# its validation record until this delegation exists.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

SUBDOMAIN="3d.zach.nz"
PARENT=""
PROFILE="${AWS_PROFILE:-}"
PARENT_PROFILE=""
DRY_RUN=""
TTL=172800

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subdomain) SUBDOMAIN="${2:-}"; shift 2 ;;
    --parent) PARENT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --parent-profile) PARENT_PROFILE="${2:-}"; shift 2 ;;
    --ttl) TTL="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[[ -n "$PARENT_PROFILE" ]] || die "--parent-profile (the account holding the parent zone) is required"
command -v jq >/dev/null || die "jq is required (brew install jq)"
# Default the parent to the subdomain minus its first label: 3d.zach.nz -> zach.nz
[[ -n "$PARENT" ]] || PARENT="${SUBDOMAIN#*.}"

deploy_aws() { if [[ -n "$PROFILE" ]]; then aws --profile "$PROFILE" "$@"; else aws "$@"; fi; }
parent_aws() { aws --profile "$PARENT_PROFILE" "$@"; }

# --- find the subdomain zone in the deploy account ---------------------------
SUB_ZONE_ID=$(deploy_aws route53 list-hosted-zones-by-name \
  --dns-name "$SUBDOMAIN." --max-items 1 \
  --query "HostedZones[?Name=='${SUBDOMAIN}.'].Id | [0]" --output text)
[[ "$SUB_ZONE_ID" != "None" && -n "$SUB_ZONE_ID" ]] \
  || die "no hosted zone for $SUBDOMAIN in the deploy account — deploy with threedHost:domainEnabled=true first"

# Read into an array the long way: macOS ships bash 3.2, which has no mapfile.
NAMESERVERS=()
while IFS= read -r ns; do
  [[ -n "$ns" ]] && NAMESERVERS+=("$ns")
done < <(deploy_aws route53 get-hosted-zone --id "$SUB_ZONE_ID" \
  --query 'DelegationSet.NameServers[]' --output text | tr '\t' '\n')
[[ ${#NAMESERVERS[@]} -gt 0 ]] || die "could not read the delegation set for $SUBDOMAIN"

echo "subdomain zone: ${SUB_ZONE_ID#/hostedzone/}"
printf '  ns: %s\n' "${NAMESERVERS[@]}"

# --- find the parent zone in the domains account -----------------------------
PARENT_ZONE_ID=$(parent_aws route53 list-hosted-zones-by-name \
  --dns-name "$PARENT." --max-items 1 \
  --query "HostedZones[?Name=='${PARENT}.'].Id | [0]" --output text)
[[ "$PARENT_ZONE_ID" != "None" && -n "$PARENT_ZONE_ID" ]] \
  || die "no hosted zone for $PARENT in profile $PARENT_PROFILE"
echo "parent zone:    ${PARENT_ZONE_ID#/hostedzone/} (profile $PARENT_PROFILE)"

RECORDS=$(printf '%s\n' "${NAMESERVERS[@]}" | jq -R '{Value: .}' | jq -s '.')
CHANGE=$(jq -n --arg name "$SUBDOMAIN" --argjson ttl "$TTL" --argjson records "$RECORDS" \
  '{Comment: "Delegate \($name) to its own hosted zone",
    Changes: [{Action: "UPSERT",
               ResourceRecordSet: {Name: $name, Type: "NS", TTL: $ttl,
                                   ResourceRecords: $records}}]}')

if [[ -n "$DRY_RUN" ]]; then
  echo "--dry-run, would submit:"
  echo "$CHANGE"
  exit 0
fi

CHANGE_ID=$(parent_aws route53 change-resource-record-sets \
  --hosted-zone-id "$PARENT_ZONE_ID" \
  --change-batch "$CHANGE" \
  --query 'ChangeInfo.Id' --output text)
echo "submitted $CHANGE_ID — waiting for it to propagate…"
parent_aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
echo "done. $SUBDOMAIN is delegated; certificate validation can now complete."
