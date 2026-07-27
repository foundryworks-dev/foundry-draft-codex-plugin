#!/usr/bin/env bash
# Install the Foundry/Draft Codex integration:
#
#   1. copy the custom prompts into ~/.codex/prompts/
#   2. register the draft MCP server in ~/.codex/config.toml
#
# Both steps are idempotent — re-running refreshes the prompts and
# leaves an existing [mcp_servers.draft] block untouched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PROMPTS_DIR="$CODEX_HOME/prompts"
CONFIG="$CODEX_HOME/config.toml"

echo "Foundry/Draft Codex integration — installing into $CODEX_HOME"

# --- Node check (the MCP server needs Node 18+ for global fetch) ----
if ! command -v node >/dev/null 2>&1; then
  echo "  ! Node is not on PATH. The MCP server needs Node 18+ — install it"
  echo "    before using /prompts:draft-work or /prompts:draft-queue."
else
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 18 ]; then
    echo "  ! Node $(node -v) is too old — the MCP server needs Node 18+."
  fi
fi

# --- 1. prompts -----------------------------------------------------
mkdir -p "$PROMPTS_DIR"
cp "$REPO_DIR"/prompts/*.md "$PROMPTS_DIR/"
echo "  ✓ copied prompts → $PROMPTS_DIR"
echo "    (/prompts:draft-work, /prompts:draft-queue, /prompts:draft-refresh, /prompts:draft-agents)"

# --- 1b. registry broker client -------------------------------------
# The draft-agents prompt shells out to this to talk to the local
# Foundry Agent Registry daemon (#194). Prompts run from ~/.codex, so
# the client is installed under $CODEX_HOME/scripts where they can find it.
mkdir -p "$CODEX_HOME/scripts"
cp "$REPO_DIR"/scripts/foundry-registry.js "$CODEX_HOME/scripts/"
echo "  ✓ copied registry broker client → $CODEX_HOME/scripts/foundry-registry.js"

# --- 2. MCP server in config.toml -----------------------------------
mkdir -p "$CODEX_HOME"
touch "$CONFIG"
# Two entries, same script. The tool namespace a client exposes
# (mcp__draft__queue vs mcp__foundry__queue) comes from the *config key*,
# not from anything the MCP server itself returns — tools/list hands back
# bare names. So aliasing the prefix means mounting the server twice
# (#457). `foundry` is the name to use going forward; `draft` stays until
# the telemetry gate (#458) says nobody is calling it.
add_entry() { # $1 = config key
  cat >> "$CONFIG" <<EOF

[mcp_servers.$1]
command = "node"
# --server-key tells the process which namespace it is serving. Both
# entries run the same script, and tools/list returns bare names either
# way, so without it the two are indistinguishable from the inside —
# and the legacy-prefix signal #458 needs would be unmeasurable.
args = ["$REPO_DIR/mcp/draft-mcp.js", "--server-key=$1"]
# Forward the agent credentials from your shell environment rather
# than hard-coding the key into this file. Both name pairs are listed so
# an operator on either one keeps working — the server prefers FOUNDRY_*
# and falls back to DRAFT_* (#456).
env_vars = ["FOUNDRY_API_KEY", "FOUNDRY_API_URL", "DRAFT_API_KEY", "DRAFT_API_URL"]
EOF
  echo "  ✓ added [mcp_servers.$1] → $CONFIG"
}

for key in foundry draft; do
  if grep -q "^\[mcp_servers\.$key\]" "$CONFIG"; then
    echo "  • [mcp_servers.$key] already in $CONFIG — left untouched"
  else
    add_entry "$key"
  fi
done

cat <<'EOF'

Done. Next steps:
  • Export your workspace agent key in your shell profile:
      export FOUNDRY_API_KEY=fdrk_...
  • (Self-hosted Foundry only) also export:
      export FOUNDRY_API_URL=https://your-foundry-host
  • The legacy DRAFT_API_KEY / DRAFT_API_URL names still work if you
    already have them exported — no need to change anything.
  • Restart Codex, then try:  /prompts:draft-queue

Optional: see AGENTS.snippet.md for a one-paragraph note you can add
to ~/.codex/AGENTS.md so Codex knows the Draft commands exist.
EOF
