#!/usr/bin/env bash
# Model-detection tests for the Codex MCP server (#554).
#
# The failure this guards is a silent no-op, which is the only kind this code
# can have: the server reads a rollout, looks for a field, and omits the
# X-Foundry-Model header when it finds nothing. Omitting is correct behaviour
# when the model is genuinely unknown, so a resolver that never resolves is
# indistinguishable from a resolver that is working on a session with no model
# — from the outside, and from the code, which is why #420's implementation
# shipped to two hosts and reported nothing on either.
#
# It was reading `message.model`, which is Claude Code's shape. Codex writes
# `turn_context.payload.model`. Right file, wrong field.
#
# These call the real resolver in mcp/draft-mcp.js against fixture rollouts in
# a temp CODEX_HOME, rather than reimplementing the parse — a second copy of
# the rule is what produced the bug.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

# Write a rollout into a fixture CODEX_HOME and echo the resolved model.
# $1 = CODEX_HOME, $2 = rollout body (one JSON object per line)
resolve_with() {
  local home="$1" body="$2"
  local day="$home/sessions/2026/08/03"
  mkdir -p "$day"
  printf '%s\n' "$body" > "$day/rollout-2026-08-03T12-00-00-test-session.jsonl"
  CODEX_HOME="$home" node -e '
    const m = require(process.argv[1] + "/mcp/draft-mcp.js");
    process.stdout.write(m.readModelFromTranscript() || "");
  ' "$REPO"
}

META='{"type":"session_meta","payload":{"session_id":"test-session","cwd":"'"$WORK"'"}}'

# 1. The real shape. This is what every rollout on a live machine looks like.
H="$WORK/h1"
got="$(resolve_with "$H" "$META
{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\"}}")"
[ "$got" = "gpt-5.6-sol" ] && ok "turn_context.payload.model resolves" \
  || bad "turn_context.payload.model resolves (got '$got')"

# 2. Claude Code's shape must NOT resolve. This is the regression itself: the
#    previous implementation read only this, so a rollout carrying it would
#    have passed while every real Codex rollout returned nothing. Asserting it
#    stays unresolved keeps anyone from "fixing" this by accepting both and
#    quietly reintroducing a Claude-shaped reader.
H="$WORK/h2"
got="$(resolve_with "$H" "$META
{\"type\":\"response_item\",\"message\":{\"model\":\"claude-opus-5\"}}")"
[ -z "$got" ] && ok "Claude Code's message.model is not a Codex source" \
  || bad "Claude Code's message.model must not resolve (got '$got')"

# 3. A model switched mid-session attributes to the later one, so spend is
#    priced at what was actually running when it was spent.
H="$WORK/h3"
got="$(resolve_with "$H" "$META
{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\"}}
{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-pro\"}}")"
[ "$got" = "gpt-5.6-pro" ] && ok "last turn_context wins on a mid-session switch" \
  || bad "last turn_context wins (got '$got')"

# 4. world_state is the fallback when a rollout carries no turn_context.
H="$WORK/h4"
got="$(resolve_with "$H" "$META
{\"type\":\"world_state\",\"payload\":{\"state\":{\"model\":\"gpt-5.6-sol\"}}}")"
[ "$got" = "gpt-5.6-sol" ] && ok "world_state.payload.state.model is a fallback" \
  || bad "world_state fallback (got '$got')"

# 5. Unknown stays unknown. Omitting the header is the designed behaviour when
#    there is nothing to report -- a guessed model produces a confident wrong
#    cost, which is worse than an acknowledged gap.
H="$WORK/h5"
got="$(resolve_with "$H" "$META
{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}")"
[ -z "$got" ] && ok "a rollout with no model resolves to nothing" \
  || bad "no-model rollout must resolve to nothing (got '$got')"

# 6. Outside Codex entirely: no sessions dir at all. Must not throw.
H="$WORK/h6"; mkdir -p "$H"
got="$(CODEX_HOME="$H" node -e '
  const m = require(process.argv[1] + "/mcp/draft-mcp.js");
  process.stdout.write(m.readModelFromTranscript() || "");
' "$REPO")"
[ -z "$got" ] && ok "no rollouts at all is silent, not an error" \
  || bad "missing sessions dir (got '$got')"

# 7. Requiring the module must not start the server. If it did, this whole
#    file would hang on stdin rather than fail, so assert it exits.
timeout 10 node -e '
  const m = require(process.argv[1] + "/mcp/draft-mcp.js");
  if (typeof m.modelHeaders !== "function") { process.exit(3); }
' "$REPO" && ok "require() exports the resolver without starting the server" \
  || bad "require() must not start the server"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
