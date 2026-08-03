#!/usr/bin/env bash
# Install-ordering tests for the two installers (#534).
#
# The failure this guards is #520: two [mcp_servers.<key>] entries in
# config.toml, which is a duplicate TOML key, which makes Codex refuse to load
# the file at all. It is not a subtle regression — the editor stops working —
# and it has now been reached from both directions, once per key.
#
# The orderings matter because the two installers write the same block from
# different places. A test that only installs one way passes while the other
# way bricks the config, which is exactly how #534 shipped: the clone path
# wrote `foundry`, the remote path never did, and nothing ran both.
#
# No network: the remote installer takes FOUNDRY_DOWNLOAD_BASE, and its
# curl calls accept file:// — so we build a real tarball from the working tree
# and serve it off disk. This runs install-codex.sh itself, not a copy of its
# logic.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# --- a local "dl.foundryworks.dev" -------------------------------------------
DL="$WORK/dl"
VER="v9.9.9"
mkdir -p "$DL/codex-plugin/$VER"
printf '%s\n' "$VER" > "$DL/codex-plugin/latest.txt"
tar -czf "$DL/codex-plugin/$VER/foundry-draft-codex-plugin.tar.gz" \
    -C "$REPO" mcp skills scripts README.md
( cd "$DL/codex-plugin/$VER" \
  && { command -v sha256sum >/dev/null 2>&1 \
        && sha256sum foundry-draft-codex-plugin.tar.gz > SHA256SUMS \
        || shasum -a 256 foundry-draft-codex-plugin.tar.gz > SHA256SUMS; } )

remote_install() { # remote_install <codex-home>
  CODEX_HOME="$1" \
  FOUNDRY_CODEX_INSTALL_DIR="$1/install-root" \
  FOUNDRY_DOWNLOAD_BASE="file://$DL" \
    sh "$REPO/install-codex.sh" >/dev/null 2>&1
}
clone_install() { # clone_install <codex-home>
  CODEX_HOME="$1" bash "$REPO/scripts/install.sh" >/dev/null 2>&1
}

count_key() { grep -c "^\[mcp_servers\.$2\]" "$1/config.toml" || true; }

# Does Codex load it? A duplicate key is what breaks, and that is exactly what
# a TOML parser rejects — so parse the file rather than eyeballing the counts.
parses() {
  python3 - "$1/config.toml" <<'PY' 2>/dev/null
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    tomllib.load(f)
PY
}

# --- 1. remote install alone -------------------------------------------------
H="$WORK/h1"; mkdir -p "$H"
remote_install "$H"
check "remote: one [mcp_servers.foundry]" "$(count_key "$H" foundry)" "1"
check "remote: one [mcp_servers.draft]"   "$(count_key "$H" draft)"   "1"
if parses "$H"; then ok "remote: config.toml parses"; else bad "remote: config.toml parses"; fi

# --- 2. clone install alone --------------------------------------------------
H="$WORK/h2"; mkdir -p "$H"
clone_install "$H"
check "clone: one [mcp_servers.foundry]" "$(count_key "$H" foundry)" "1"
check "clone: one [mcp_servers.draft]"   "$(count_key "$H" draft)"   "1"

# --- 3. clone THEN remote ----------------------------------------------------
# The ordering that bricked Codex in #520 and would have again in #534.
H="$WORK/h3"; mkdir -p "$H"
clone_install "$H"
remote_install "$H"
check "clone→remote: one foundry" "$(count_key "$H" foundry)" "1"
check "clone→remote: one draft"   "$(count_key "$H" draft)"   "1"
if parses "$H"; then ok "clone→remote: config.toml parses"; else bad "clone→remote: config.toml parses"; fi

# --- 4. remote THEN clone ----------------------------------------------------
H="$WORK/h4"; mkdir -p "$H"
remote_install "$H"
clone_install "$H"
check "remote→clone: one foundry" "$(count_key "$H" foundry)" "1"
check "remote→clone: one draft"   "$(count_key "$H" draft)"   "1"
if parses "$H"; then ok "remote→clone: config.toml parses"; else bad "remote→clone: config.toml parses"; fi

# --- 5. re-running either is idempotent --------------------------------------
H="$WORK/h5"; mkdir -p "$H"
remote_install "$H"; remote_install "$H"; clone_install "$H"; clone_install "$H"
check "re-runs: one foundry" "$(count_key "$H" foundry)" "1"
check "re-runs: one draft"   "$(count_key "$H" draft)"   "1"

# --- 6. an unmarked entry is refused, not overwritten ------------------------
# What a pre-#534 clone install left behind: `foundry` outside the markers.
# Appending on top is the duplicate-key crash, so both installers must stop —
# and must not touch the user's file on the way out.
for who in remote clone; do
  H="$WORK/h6-$who"; mkdir -p "$H"
  cat > "$H/config.toml" <<'EOF'
[mcp_servers.somebody_elses]
command = "node"
args = ["/somewhere/else.js"]

[mcp_servers.foundry]
command = "node"
args = ["/old/clone/mcp/draft-mcp.js", "--server-key=foundry"]
EOF
  before="$(cat "$H/config.toml")"
  if [ "$who" = remote ]; then rc=0; remote_install "$H" || rc=$?; else rc=0; clone_install "$H" || rc=$?; fi
  [ "$rc" -ne 0 ] && ok "$who: refuses an unmarked entry" || bad "$who: refuses an unmarked entry"
  check "$who: leaves the config untouched" "$(cat "$H/config.toml")" "$before"
done

# --- 7. the two installers write the same block ------------------------------
# Two copies of one rule is how this file family keeps breaking. Compare the
# blocks they actually emit, with the args path normalized away.
block() { # block <codex-home>
  awk '/^# BEGIN foundry-draft/{f=1} f{print} /^# END foundry-draft/{f=0}' "$1/config.toml" \
    | sed -E 's|args = \["[^"]*"|args = ["PATH"|'
}
if [ "$(block "$WORK/h1")" = "$(block "$WORK/h2")" ]; then
  ok "remote and clone emit the same managed block"
else
  bad "remote and clone emit the same managed block"
  diff <(block "$WORK/h1") <(block "$WORK/h2") || true
fi

# --- 8. uninstall removes both keys ------------------------------------------
H="$WORK/h8"; mkdir -p "$H"
printf '[mcp_servers.somebody_elses]\ncommand = "node"\n' > "$H/config.toml"
remote_install "$H"
CODEX_HOME="$H" FOUNDRY_CODEX_INSTALL_DIR="$H/install-root" \
  FOUNDRY_DOWNLOAD_BASE="file://$DL" sh "$REPO/install-codex.sh" --uninstall >/dev/null 2>&1
check "uninstall: no foundry left" "$(count_key "$H" foundry)" "0"
check "uninstall: no draft left"   "$(count_key "$H" draft)"   "0"
check "uninstall: keeps other servers" \
  "$(grep -c '^\[mcp_servers\.somebody_elses\]' "$H/config.toml" || true)" "1"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
