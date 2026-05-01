#!/usr/bin/env bash
# scripts/sk.sh — StateKeep CLI helper
# Usage:
#   export STATEKEEP_URL=https://your-domain
#   export STATEKEEP_KEY=sk_...
#
#   sk validate my-machine.json
#   sk scenario my-machine.scenarios.json
#   sk deploy my-machine.json order-v2 [--parent order-v1]
#   sk actors
#   sk actor <id>
#   sk events <actorId>
#   sk spawn <definitionId> [context-json]
#   sk send <actorId> <EVENT_TYPE> [payload-json]
#   sk keys list
#   sk keys create <label> [tier]
#   sk keys revoke <keyId>

set -euo pipefail

URL="${STATEKEEP_URL:-http://localhost:3001}"
KEY="${STATEKEEP_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "Error: STATEKEEP_KEY not set" >&2
  exit 1
fi

api() {
  local method="$1"; local path="$2"; shift 2
  curl -sf -X "$method" "${URL}${path}" \
    -H "X-API-Key: ${KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

pretty() { python3 -m json.tool 2>/dev/null || cat; }

CMD="${1:-help}"
shift || true

case "$CMD" in
  validate)
    FILE="${1:?Usage: sk validate <machine.json>}"
    DEFINITION=$(cat "$FILE")
    api POST /v1/definitions/validate -d "{\"definition\":${DEFINITION}}" | pretty
    ;;

  scenario)
    FILE="${1:?Usage: sk scenario <scenarios.json>}"
    api POST /v1/definitions/scenario -d @"$FILE" | pretty
    ;;

  deploy)
    FILE="${1:?Usage: sk deploy <machine.json> <id> [--parent <parentId>]}"
    ID="${2:?provide definition ID}"
    PARENT=""
    if [[ "${3:-}" == "--parent" ]]; then PARENT="\"parentId\":\"${4:?}\","; fi
    DEFINITION=$(cat "$FILE")
    api PUT /v1/definitions -d "{${PARENT}\"id\":\"${ID}\",\"definition\":${DEFINITION}}" | pretty
    ;;

  actors)
    FILTER="${1:-}"
    URL_PATH="/v1/actors?limit=50"
    [[ -n "$FILTER" ]] && URL_PATH+="&definitionId=${FILTER}"
    api GET "$URL_PATH" | pretty
    ;;

  actor)
    ID="${1:?provide actor ID}"
    api GET "/v1/actors/${ID}/state" | pretty
    ;;

  events)
    ID="${1:?provide actor ID}"
    OFFSET="${2:-0}"
    api GET "/v1/actors/${ID}/events?limit=50&offset=${OFFSET}" | pretty
    ;;

  spawn)
    DEF_ID="${1:?provide definitionId}"
    CTX="${2:-{}}"
    api POST /v1/actors -d "{\"definitionId\":\"${DEF_ID}\",\"initialContext\":${CTX}}" | pretty
    ;;

  send)
    ID="${1:?provide actor ID}"
    TYPE="${2:?provide event type}"
    PAYLOAD="${3:-}"
    if [[ -n "$PAYLOAD" ]]; then
      api POST "/v1/actors/${ID}/event" -d "{\"type\":\"${TYPE}\",\"payload\":${PAYLOAD}}" | pretty
    else
      api POST "/v1/actors/${ID}/event" -d "{\"type\":\"${TYPE}\"}" | pretty
    fi
    ;;

  keys)
    SUB="${1:-list}"
    case "$SUB" in
      list)   api GET /v1/keys | pretty ;;
      create) api POST /v1/keys -d "{\"label\":\"${2:?label}\",\"tier\":\"${3:-free}\"}" | pretty ;;
      revoke) api DELETE "/v1/keys/${2:?keyId}" && echo "Revoked." ;;
      *) echo "Unknown: sk keys $SUB" ;;
    esac
    ;;

  health)
    api GET /v1/health | pretty
    ;;

  diff)
    ID="${1:?provide definition ID}"
    api GET "/v1/definitions/${ID}/diff" | pretty
    ;;

  *)
    echo "StateKeep CLI (sk.sh)"
    echo ""
    echo "Commands:"
    echo "  validate  <file.json>                     Validate machine definition"
    echo "  scenario  <file.json>                     Run scenario test suite"
    echo "  deploy    <file.json> <id> [--parent id]  Deploy definition"
    echo "  diff      <id>                            Diff vs parent definition"
    echo "  actors    [definitionId]                  List actors"
    echo "  actor     <id>                            Get actor state"
    echo "  events    <id> [offset]                   Get actor event history"
    echo "  spawn     <definitionId> [context-json]   Spawn actor"
    echo "  send      <id> <EVENT> [payload-json]     Send event to actor"
    echo "  keys      list|create|revoke              Manage API keys"
    echo "  health                                    Health check"
    ;;
esac
