#!/usr/bin/env bash
# Install the Foundry/Draft Codex integration:
#
#   1. copy the foundry-* skills into ~/.codex/skills/
#   2. register the foundry + draft MCP servers in ~/.codex/config.toml
#
# Both steps are idempotent — re-running refreshes the skills and rewrites
# the managed config block in place. An MCP entry outside that block is
# someone else's; the script stops rather than touching it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="$CODEX_HOME/skills"
CONFIG="$CODEX_HOME/config.toml"

echo "Foundry/Draft Codex integration — installing into $CODEX_HOME"

# --- Node check (the MCP server needs Node 18+ for global fetch) ----
if ! command -v node >/dev/null 2>&1; then
  echo "  ! Node is not on PATH. The MCP server needs Node 18+ — install it"
  echo "    before using \$foundry-work or \$foundry-queue."
else
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 18 ]; then
    echo "  ! Node $(node -v) is too old — the MCP server needs Node 18+."
  fi
fi

# --- 1. skills ------------------------------------------------------
# Codex reads skills from $CODEX_HOME/skills/<name>/SKILL.md. It does not
# read a prompts/ directory at all — the mechanism this repo shipped until
# #527 was silently inert on Codex 0.146+.
mkdir -p "$SKILLS_DIR"
for d in "$REPO_DIR"/skills/*/; do
  [ -d "$d" ] || continue
  rm -rf "$SKILLS_DIR/$(basename "$d")"
  # ${d%/} strips the trailing slash — `cp -R dir/ dest/` copies the
  # directory *contents* into dest, not the directory itself.
  cp -R "${d%/}" "$SKILLS_DIR/"
done
echo "  ✓ copied skills → $SKILLS_DIR"
echo "    (\$foundry-work, \$foundry-watch, \$foundry-queue, \$foundry-refresh, \$foundry-agents)"

# Clear the inert prompt files a pre-#527 checkout left behind, so a stale
# copy can't look like a working install.
for s in foundry-agents foundry-queue foundry-refresh foundry-watch foundry-work \
         draft-agents draft-queue draft-refresh draft-watch draft-work; do
  rm -f "$CODEX_HOME/prompts/$s.md"
done
rmdir "$CODEX_HOME/prompts" 2>/dev/null || true

# --- 1b. registry broker client -------------------------------------
# The foundry-agents skill shells out to this to talk to the local
# Foundry Agent Registry daemon (#194). Skills run from ~/.codex, so
# the client is installed under $CODEX_HOME/scripts where they can find it.
mkdir -p "$CODEX_HOME/scripts"
cp "$REPO_DIR"/scripts/foundry-registry.js "$CODEX_HOME/scripts/"
echo "  ✓ copied registry broker client → $CODEX_HOME/scripts/foundry-registry.js"

# --- 2. MCP server in config.toml -----------------------------------
mkdir -p "$CODEX_HOME"
touch "$CONFIG"

# This script and the remote installer (dl.foundryworks.dev/install-codex.sh)
# manage the SAME block, delimited by these sentinels. Whichever runs last
# strips the block and rewrites it, so re-running either is idempotent and the
# entries point at the install you just ran.
#
# The strings must match install-codex.sh byte-for-byte — its awk compares with
# $0 == b. scripts/test-install.sh asserts the two emit an identical block,
# because two copies of one rule is how this file family keeps breaking.
#
# History, because the asymmetry here was deliberate and is now gone: `foundry`
# used to be written *outside* the sentinels. The remote installer never wrote
# that key, so marking it would have had the remote installer delete an entry
# it did not know how to restore. The cost was that a remote install had no
# `foundry` key at all, so the #457 prefix simply did not work on Codex (#534).
# Since #519 both installers live in this repo and release together, so they
# can agree on one managed block instead of one working around the other.
BEGIN_MARK="# BEGIN foundry-draft (managed by install-codex.sh — do not edit)"
END_MARK="# END foundry-draft"

# Entries for our keys outside the managed block — someone else's, or left by
# a version that wrote `foundry` unmarked. Appending ours on top would make a
# duplicate TOML key and Codex would refuse to load config.toml at all (#520).
unmarked_entries() {
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip && /^\[mcp_servers\.(foundry|draft)\]/ { print NR ": " $0 }
  ' "$CONFIG"
}

stray="$(unmarked_entries)"
if [ -n "$stray" ]; then
  echo "  ! $CONFIG has an MCP entry this script does not manage:" >&2
  printf '%s\n' "$stray" | sed 's/^/      /' >&2
  cat >&2 <<EOF

  These predate the current installer, which keeps both entries inside the
  '# BEGIN foundry-draft' markers. Adding ours on top would leave two of the
  same TOML key, and Codex would refuse to start.

  Delete each block listed above — from its [mcp_servers....] line down to
  (but not including) the next line starting with '[' — then re-run.
EOF
  exit 1
fi

strip_managed_block() {
  tmp="$(mktemp)"
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip   { print }
  ' "$CONFIG" > "$tmp"
  awk 'BEGIN{blank=0} { if ($0=="") {blank++} else {for(i=0;i<blank;i++)print "";blank=0;print} } END{}' "$tmp" > "$CONFIG"
  rm -f "$tmp"
}

strip_managed_block
[ -s "$CONFIG" ] && printf '\n' >> "$CONFIG"
cat >> "$CONFIG" <<EOF
$BEGIN_MARK
[mcp_servers.foundry]
command = "node"
# --server-key tells the process which namespace it is serving. Both entries
# run the same script and tools/list returns bare names either way, so without
# it the two are indistinguishable from the inside — and the legacy-prefix
# signal #458 needs would be unmeasurable.
args = ["$REPO_DIR/mcp/draft-mcp.js", "--server-key=foundry"]
# Credentials come from your shell environment, not this file. Both name
# pairs are listed so an operator on either keeps working — the MCP server
# prefers FOUNDRY_* and falls back to DRAFT_* (#456).
env_vars = ["FOUNDRY_API_KEY", "FOUNDRY_API_URL", "DRAFT_API_KEY", "DRAFT_API_URL"]

[mcp_servers.draft]
command = "node"
args = ["$REPO_DIR/mcp/draft-mcp.js", "--server-key=draft"]
env_vars = ["FOUNDRY_API_KEY", "FOUNDRY_API_URL", "DRAFT_API_KEY", "DRAFT_API_URL"]
$END_MARK
EOF
echo "  ✓ wrote [mcp_servers.foundry] + [mcp_servers.draft] → $CONFIG"

cat <<'EOF'

Done. Next steps:
  • Export your workspace agent key in your shell profile:
      export FOUNDRY_API_KEY=fdrk_...
  • (Self-hosted Foundry only) also export:
      export FOUNDRY_API_URL=https://your-foundry-host
  • The legacy DRAFT_API_KEY / DRAFT_API_URL names still work if you
    already have them exported — no need to change anything.
  • Restart Codex, then try:  $foundry-queue

Optional: see AGENTS.snippet.md for a one-paragraph note you can add
to ~/.codex/AGENTS.md so Codex knows the Draft commands exist.
EOF
