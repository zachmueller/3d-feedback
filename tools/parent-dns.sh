#!/usr/bin/env bash
#
# DNS for this stack's subdomain, served from the PARENT zone (zach.nz) rather
# than a zone of its own.
#
#   tools/parent-dns.sh --parent-profile domains [--profile deploy-profile] \
#       [--parent zach.nz] [--subdomain 3d.zach.nz] [--stack ThreedHostStack] \
#       [--cf-domain dxxxxxxxx.cloudfront.net] [--region us-east-1] \
#       [--only validation|aliases] [--dry-run]
#   tools/parent-dns.sh --parent-profile domains --remove-delegation [--dry-run]
#   tools/parent-dns.sh --retire-child-zone [--profile deploy-profile] [--yes]
#
# The parent zone lives in a separate `domains` account, and CloudFormation
# cannot write records into a zone in another account — nor can ACM's automatic
# DNS validation. So the two records the site needs are created here:
#
#   <subdomain>           A + AAAA alias -> the CloudFront distribution
#   _<token>.<subdomain>  CNAME          -> ACM's validation value
#
# Both are stable — the distribution keeps its domain name for life, and ACM
# reuses one validation token per domain per account — so this is normally a
# one-time run. Every change is an UPSERT, so re-running is safe and idempotent.
#
# The two exclusive modes are migration steps, run once each:
#   --remove-delegation   drop the old `<subdomain> NS` record from the parent
#                         zone, after the records above are in place
#   --retire-child-zone   delete the subdomain's own hosted zone in the deploy
#                         account, once the old NS TTL (48h) has expired
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

SUBDOMAIN="3d.zach.nz"
PARENT=""
PROFILE="${AWS_PROFILE:-}"
PARENT_PROFILE=""
STACK="ThreedHostStack"
CF_DOMAIN=""
REGION="us-east-1"
ONLY=""
DRY_RUN=""
REMOVE_DELEGATION=""
RETIRE_CHILD_ZONE=""
ASSUME_YES=""
TTL=300

# Fixed, global, and the same for every distribution: the zone id Route 53 wants
# in an alias target that points at CloudFront.
CLOUDFRONT_ZONE_ID="Z2FDTNDATAQYW2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subdomain) SUBDOMAIN="${2:-}"; shift 2 ;;
    --parent) PARENT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --parent-profile) PARENT_PROFILE="${2:-}"; shift 2 ;;
    --stack) STACK="${2:-}"; shift 2 ;;
    --cf-domain) CF_DOMAIN="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --ttl) TTL="${2:-}"; shift 2 ;;
    --remove-delegation) REMOVE_DELEGATION=1; shift ;;
    --retire-child-zone) RETIRE_CHILD_ZONE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

command -v jq >/dev/null || die "jq is required (brew install jq)"
case "$ONLY" in ''|validation|aliases) ;; *) die "--only takes validation or aliases" ;; esac
[[ -z "$REMOVE_DELEGATION" || -z "$RETIRE_CHILD_ZONE" ]] \
  || die "--remove-delegation and --retire-child-zone are separate steps; run one at a time"
# Default the parent to the subdomain minus its first label: 3d.zach.nz -> zach.nz
[[ -n "$PARENT" ]] || PARENT="${SUBDOMAIN#*.}"

deploy_aws() { if [[ -n "$PROFILE" ]]; then aws --profile "$PROFILE" "$@"; else aws "$@"; fi; }
parent_aws() { aws --profile "$PARENT_PROFILE" "$@"; }

# ---- child zone teardown (deploy account only; no parent-zone access needed) --
if [[ -n "$RETIRE_CHILD_ZONE" ]]; then
  ZONE_ID=$(deploy_aws route53 list-hosted-zones-by-name \
    --dns-name "$SUBDOMAIN." --max-items 1 \
    --query "HostedZones[?Name=='${SUBDOMAIN}.'].Id | [0]" --output text)
  if [[ "$ZONE_ID" == "None" || -z "$ZONE_ID" ]]; then
    echo "no hosted zone for $SUBDOMAIN in the deploy account — already retired."
    exit 0
  fi
  ZONE_ID="${ZONE_ID#/hostedzone/}"

  # The apex NS and SOA go with the zone itself; everything else has to go first,
  # or DeleteHostedZone fails with HostedZoneNotEmpty.
  LEFTOVERS=$(deploy_aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --output json | jq -c --arg apex "${SUBDOMAIN}." \
    '[.ResourceRecordSets[] | select((.Name == $apex and (.Type == "NS" or .Type == "SOA")) | not)]')

  echo "child zone:  $ZONE_ID ($SUBDOMAIN, deploy account)"
  echo "$LEFTOVERS" | jq -r '.[] | "  delete \(.Type)\t\(.Name)"'

  if [[ -n "$DRY_RUN" ]]; then
    echo "--dry-run, would delete the records above and then the zone."
    exit 0
  fi

  echo
  echo "Check first that nothing still resolves through this zone:"
  echo "    dig +short NS $SUBDOMAIN     # expect no answer"
  echo "    dig +short A  $SUBDOMAIN     # expect the CloudFront addresses"
  if [[ -z "$ASSUME_YES" ]]; then
    printf 'Delete zone %s and its records? type "delete" to confirm: ' "$ZONE_ID"
    read -r REPLY
    [[ "$REPLY" == "delete" ]] || die "not confirmed"
  fi

  if [[ "$(jq 'length' <<<"$LEFTOVERS")" != "0" ]]; then
    BATCH=$(jq -n --argjson records "$LEFTOVERS" \
      '{Comment: "Empty the zone before deleting it",
        Changes: [$records[] | {Action: "DELETE", ResourceRecordSet: .}]}')
    CHANGE_ID=$(deploy_aws route53 change-resource-record-sets \
      --hosted-zone-id "$ZONE_ID" --change-batch "$BATCH" \
      --query 'ChangeInfo.Id' --output text)
    echo "emptying zone ($CHANGE_ID)…"
    deploy_aws route53 wait resource-record-sets-changed --id "$CHANGE_ID"
  fi
  deploy_aws route53 delete-hosted-zone --id "$ZONE_ID" >/dev/null
  echo "done. $SUBDOMAIN is served entirely from $PARENT now, and the extra zone is gone."
  exit 0
fi

# ---- everything below writes to the parent zone ------------------------------
[[ -n "$PARENT_PROFILE" ]] || die "--parent-profile (the account holding the $PARENT zone) is required"

PARENT_ZONE_ID=$(parent_aws route53 list-hosted-zones-by-name \
  --dns-name "$PARENT." --max-items 1 \
  --query "HostedZones[?Name=='${PARENT}.'].Id | [0]" --output text)
[[ "$PARENT_ZONE_ID" != "None" && -n "$PARENT_ZONE_ID" ]] \
  || die "no hosted zone for $PARENT in profile $PARENT_PROFILE"
PARENT_ZONE_ID="${PARENT_ZONE_ID#/hostedzone/}"
echo "parent zone: $PARENT_ZONE_ID ($PARENT, profile $PARENT_PROFILE)"

CHANGES="[]"
add_change() { CHANGES=$(jq -c --argjson change "$1" '. + [$change]' <<<"$CHANGES"); }

submit() {
  local comment="$1"
  if [[ "$(jq 'length' <<<"$CHANGES")" == "0" ]]; then
    echo "nothing to change."
    return 0
  fi
  local batch
  batch=$(jq -n --arg comment "$comment" --argjson changes "$CHANGES" \
    '{Comment: $comment, Changes: $changes}')
  if [[ -n "$DRY_RUN" ]]; then
    echo "--dry-run, would submit:"
    echo "$batch" | jq .
    return 0
  fi
  local change_id
  change_id=$(parent_aws route53 change-resource-record-sets \
    --hosted-zone-id "$PARENT_ZONE_ID" --change-batch "$batch" \
    --query 'ChangeInfo.Id' --output text)
  echo "submitted $change_id — waiting for it to propagate…"
  parent_aws route53 wait resource-record-sets-changed --id "$change_id"
  echo "done."
}

# ---- drop the old delegation (exclusive step) ---------------------------------
if [[ -n "$REMOVE_DELEGATION" ]]; then
  NS_RRSET=$(parent_aws route53 list-resource-record-sets \
    --hosted-zone-id "$PARENT_ZONE_ID" \
    --start-record-name "${SUBDOMAIN}." --start-record-type NS --max-items 1 \
    --query "ResourceRecordSets[?Name=='${SUBDOMAIN}.' && Type=='NS'] | [0]" --output json)
  if [[ "$NS_RRSET" == "null" || -z "$NS_RRSET" ]]; then
    echo "no $SUBDOMAIN NS record in the parent zone — nothing to remove."
    exit 0
  fi
  echo "$NS_RRSET" | jq -r '"  delete NS\t\(.Name) (TTL \(.TTL))"'
  echo "$NS_RRSET" | jq -r '.ResourceRecords[] | "    \(.Value)"'
  add_change "$(jq -c '{Action: "DELETE", ResourceRecordSet: .}' <<<"$NS_RRSET")"
  submit "Stop delegating $SUBDOMAIN; it is served from this zone now"
  echo
  echo "Resolvers that already cached the delegation keep using the old zone until"
  echo "its TTL expires, so leave that zone in place until then:"
  echo "    tools/parent-dns.sh --retire-child-zone --profile ${PROFILE:-<deploy-profile>}"
  exit 0
fi

# ---- ACM validation record ---------------------------------------------------
if [[ "$ONLY" != "aliases" ]]; then
  CERT_ARNS=$(deploy_aws acm list-certificates --region "$REGION" \
    --certificate-statuses PENDING_VALIDATION ISSUED \
    --query "CertificateSummaryList[?DomainName=='${SUBDOMAIN}'].CertificateArn" --output text)
  [[ -n "$CERT_ARNS" && "$CERT_ARNS" != "None" ]] \
    || die "no ACM certificate for $SUBDOMAIN in $REGION — deploy with threedHost:domainEnabled=true first"

  # A replacement certificate is PENDING_VALIDATION alongside the ISSUED one it
  # replaces; write the records for every match so this can be run in a second
  # terminal while a deploy waits on validation.
  RECORDS="[]"
  for arn in $CERT_ARNS; do
    rr=$(deploy_aws acm describe-certificate --region "$REGION" --certificate-arn "$arn" \
      --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output json)
    RECORDS=$(jq -c --argjson rr "$rr" \
      '. + ($rr | map(select(. != null))) | unique' <<<"$RECORDS")
  done
  [[ "$(jq 'length' <<<"$RECORDS")" != "0" ]] \
    || die "ACM has not published a validation record yet — wait a few seconds and re-run"

  echo "$RECORDS" | jq -r '.[] | "  upsert \(.Type)\t\(.Name) -> \(.Value)"'
  while IFS= read -r change; do add_change "$change"; done < <(
    jq -c --argjson ttl "$TTL" '.[] |
      {Action: "UPSERT",
       ResourceRecordSet: {Name: .Name, Type: .Type, TTL: $ttl,
                           ResourceRecords: [{Value: .Value}]}}' <<<"$RECORDS"
  )
fi

# ---- A/AAAA aliases to the distribution --------------------------------------
if [[ "$ONLY" != "validation" ]]; then
  if [[ -z "$CF_DOMAIN" ]]; then
    CF_DOMAIN=$(deploy_aws cloudformation describe-stacks --region "$REGION" \
      --stack-name "$STACK" \
      --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue | [0]" \
      --output text 2>/dev/null || true)
  fi
  if [[ -z "$CF_DOMAIN" || "$CF_DOMAIN" == "None" ]]; then
    echo "warning: no CloudFrontDomain output on stack $STACK — skipping the alias" >&2
    echo "         records. Pass --cf-domain, or deploy the stack first." >&2
  else
    printf '  upsert %s\t%s -> %s (alias)\n' A "$SUBDOMAIN" "$CF_DOMAIN"
    printf '  upsert %s\t%s -> %s (alias)\n' AAAA "$SUBDOMAIN" "$CF_DOMAIN"
    for type in A AAAA; do
      add_change "$(jq -nc --arg name "$SUBDOMAIN" --arg type "$type" \
        --arg dns "$CF_DOMAIN" --arg zone "$CLOUDFRONT_ZONE_ID" \
        '{Action: "UPSERT",
          ResourceRecordSet: {Name: $name, Type: $type,
                              AliasTarget: {HostedZoneId: $zone, DNSName: $dns,
                                            EvaluateTargetHealth: false}}}')"
    done
  fi
fi

submit "Serve $SUBDOMAIN from this zone (CloudFront alias + ACM validation)"
