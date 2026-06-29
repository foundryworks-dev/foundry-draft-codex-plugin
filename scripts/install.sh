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
echo "    (/prompts:draft-work, /prompts:draft-queue, /prompts:draft-refresh)"

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
# than hard-coding the key into this file.
env_vars = ["DRAFT_API_KEY", "DRAFT_API_URL"]
EOF
  echo "  ✓ added [mcp_servers.draft] → $CONFIG"
fi

cat <<'EOF'

Done. Next steps:
  • Export your workspace agent key in your shell profile:
      export DRAFT_API_KEY=fdrk_...
  • (Self-hosted Draft only) also export:
      export DRAFT_API_URL=https://your-draft-host
  • Restart Codex, then try:  /prompts:draft-queue

Optional: see AGENTS.snippet.md for a one-paragraph note you can add
to ~/.codex/AGENTS.md so Codex knows the Draft commands exist.
EOF
