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
if grep -q '^\[mcp_servers\.draft\]' "$CONFIG"; then
  echo "  • [mcp_servers.draft] already in $CONFIG — left untouched"
else
  cat >> "$CONFIG" <<EOF

[mcp_servers.draft]
command = "node"
args = ["$REPO_DIR/mcp/draft-mcp.js"]
# Forward the agent credentials from your shell environment rather
# than hard-coding the key into this file. Both name pairs are listed so
# an operator on either one keeps working — the server prefers FOUNDRY_*
# and falls back to DRAFT_* (#456).
env_vars = ["FOUNDRY_API_KEY", "FOUNDRY_API_URL", "DRAFT_API_KEY", "DRAFT_API_URL"]
EOF
  echo "  ✓ added [mcp_servers.draft] → $CONFIG"
fi

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
