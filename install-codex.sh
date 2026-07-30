#!/bin/sh
# Foundry/Draft Codex plugin installer (#419).
#
#   curl -fsSL https://dl.foundryworks.dev/install-codex.sh | sh
#
# Codex has no plugin marketplace (unlike Claude Code), so this script is the
# Codex equivalent of "/plugin install": it fetches a versioned, SHA-256-
# verified plugin tarball from dl.foundryworks.dev (Cloudflare R2 — same infra
# as the `foundry` CLI, #370), drops it somewhere stable, and wires Codex's
# config idempotently. No git clone, no manual config editing.
#
# What it does:
#   1. check prereqs (node 18+, codex)
#   2. resolve the version (latest, or FOUNDRY_CODEX_VERSION to pin)
#   3. download + verify the plugin tarball against SHA256SUMS
#   4. extract to ~/.foundry/codex-draft-plugin/<version> + a `current` symlink
#   5. wire ~/.codex/config.toml [mcp_servers.draft] inside a marked block
#   6. install the foundry-* skills + the registry broker client
#
# Re-running upgrades in place (idempotent, non-destructive). Uninstall with:
#   curl -fsSL https://dl.foundryworks.dev/install-codex.sh | sh -s -- --uninstall
#
# Environment overrides:
#   FOUNDRY_CODEX_VERSION       version to install (default: latest). "v0.1.0" or "0.1.0".
#   FOUNDRY_CODEX_INSTALL_DIR   install root (default: $HOME/.foundry/codex-draft-plugin).
#   FOUNDRY_DOWNLOAD_BASE       base URL for downloads (default: https://dl.foundryworks.dev).
#   CODEX_HOME                  Codex config dir (default: $HOME/.codex).

set -eu

PLUGIN="foundry-draft-codex-plugin"
VERSION="${FOUNDRY_CODEX_VERSION:-latest}"
INSTALL_ROOT="${FOUNDRY_CODEX_INSTALL_DIR:-$HOME/.foundry/codex-draft-plugin}"
DOWNLOAD_BASE="${FOUNDRY_DOWNLOAD_BASE:-https://dl.foundryworks.dev}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_HOME/config.toml"

# Sentinel comments delimiting the block we manage in config.toml, so we can
# refresh/remove it on re-run without touching the user's other config.
BEGIN_MARK="# BEGIN foundry-draft (managed by install-codex.sh — do not edit)"
END_MARK="# END foundry-draft"

info() { printf '  %s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---- tooling ----------------------------------------------------------------

download() { # download <url> <dest>
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
    else
        err "need curl or wget to download release assets"
    fi
}

fetch_text() { # fetch_text <url> -> body on stdout
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO - "$1"
    else
        err "need curl or wget to fetch $1"
    fi
}

sha256_of() { # sha256_of <file> -> hex digest on stdout
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        err "need sha256sum or shasum to verify the download"
    fi
}

# ---- prereqs ----------------------------------------------------------------

check_prereqs() {
    command -v node >/dev/null 2>&1 \
        || err "node is required (the MCP server runs 'node mcp/draft-mcp.js'). Install Node 18+ and re-run."
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$major" -ge 18 ] \
        || err "Node $(node -v 2>/dev/null) is too old — the MCP server needs Node 18+ (global fetch)."
    command -v codex >/dev/null 2>&1 \
        || info "note: 'codex' is not on your PATH — install the Codex CLI to use the /foundry-* skills."
}

# ---- config.toml block management -------------------------------------------

# Remove the managed block (between the sentinels) from config.toml, leaving
# everything else untouched. No-op if the file or block is absent.
strip_managed_block() {
    [ -f "$CONFIG" ] || return 0
    tmp="$(mktemp)"
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        !skip   { print }
    ' "$CONFIG" > "$tmp"
    # Collapse a trailing run of blank lines to keep the file tidy.
    awk 'BEGIN{blank=0} { if ($0=="") {blank++} else {for(i=0;i<blank;i++)print "";blank=0;print} } END{}' "$tmp" > "$CONFIG"
    rm -f "$tmp"
}

write_managed_block() { # write_managed_block <mcp-js-path>
    mkdir -p "$CODEX_HOME"
    touch "$CONFIG"
    strip_managed_block
    # Ensure a separating blank line if the file has content.
    [ -s "$CONFIG" ] && printf '\n' >> "$CONFIG"
    cat >> "$CONFIG" <<EOF
$BEGIN_MARK
[mcp_servers.draft]
command = "node"
args = ["$1"]
# Credentials come from your shell environment, not this file. Both name
# pairs are listed so an operator on either keeps working — the MCP server
# prefers FOUNDRY_* and falls back to DRAFT_* (#456).
env_vars = ["FOUNDRY_API_KEY", "FOUNDRY_API_URL", "DRAFT_API_KEY", "DRAFT_API_URL"]
$END_MARK
EOF
}

# ---- uninstall --------------------------------------------------------------

uninstall() {
    info "uninstalling $PLUGIN"
    strip_managed_block && info "removed the managed block from $CONFIG"

    # Remove exactly what was installed, by reading the install tree rather
    # than a list maintained here. install copies whatever the tarball ships —
    # so any hard-coded list on this side is a second copy of the manifest, and
    # it drifts the moment a skill is added. It already had once: the tarball
    # grew a fifth entry and every hard-coded list still named four.
    if [ -d "${INSTALL_ROOT}/current/skills" ]; then
        for d in "${INSTALL_ROOT}/current/skills"/*/; do
            [ -d "$d" ] || continue
            rm -rf "$CODEX_HOME/skills/$(basename "$d")"
        done
    fi

    # Then every generation this plugin has ever installed, which the install
    # tree cannot tell us about — it only describes the version being removed:
    #   prompts/    the pre-#527 mechanism, which Codex no longer reads at all
    #   draft-*     the pre-#476 names; installs only ever copied, never removed
    # This also covers an install tree already deleted by hand.
    for s in foundry-agents foundry-queue foundry-refresh foundry-watch foundry-work \
             draft-agents draft-queue draft-refresh draft-watch draft-work; do
        rm -rf "$CODEX_HOME/skills/$s"
        rm -f  "$CODEX_HOME/prompts/$s.md"
    done
    # Leave $CODEX_HOME/prompts itself alone unless we emptied it — it is a
    # shared directory and may hold prompts this plugin never wrote.
    rmdir "$CODEX_HOME/prompts" 2>/dev/null || true

    rm -f "$CODEX_HOME/scripts/foundry-registry.js"
    rm -rf "$INSTALL_ROOT"
    info "removed installed files ($INSTALL_ROOT, skills, broker client)"
    info "Done. Restart Codex to drop the draft MCP server."
    exit 0
}

# ---- version resolution -----------------------------------------------------

resolve_version() {
    if [ "$VERSION" != "latest" ]; then
        case "$VERSION" in
            v*) printf '%s' "$VERSION" ;;
            *) printf 'v%s' "$VERSION" ;;
        esac
        return
    fi
    # The release CI writes the newest tag to codex-plugin/latest.txt.
    v="$(fetch_text "$DOWNLOAD_BASE/codex-plugin/latest.txt" 2>/dev/null | tr -d ' \t\r\n')"
    [ -n "$v" ] || err "could not determine the latest version from $DOWNLOAD_BASE/codex-plugin/latest.txt (no release published yet?)"
    printf '%s' "$v"
}

# ---- main -------------------------------------------------------------------

main() {
    if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then
        uninstall
    fi

    info "Foundry/Draft Codex plugin installer"
    check_prereqs

    version="$(resolve_version)"
    tarball="${PLUGIN}.tar.gz"
    base="${DOWNLOAD_BASE}/codex-plugin/${version}"
    dest="${INSTALL_ROOT}/${version}"

    info "version: $version"

    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT INT TERM

    info "downloading $tarball ..."
    download "$base/$tarball" "$workdir/$tarball" \
        || err "download failed: $base/$tarball (no release for $version?)"
    download "$base/SHA256SUMS" "$workdir/SHA256SUMS" \
        || err "download failed: $base/SHA256SUMS"

    info "verifying checksum ..."
    expected="$(grep " ${tarball}\$" "$workdir/SHA256SUMS" | awk '{print $1}' | head -n1)"
    [ -n "$expected" ] || err "no checksum for $tarball in SHA256SUMS"
    actual="$(sha256_of "$workdir/$tarball")"
    [ "$expected" = "$actual" ] || err "checksum mismatch for $tarball (expected $expected, got $actual)"

    info "installing to $dest ..."
    rm -rf "$dest"
    mkdir -p "$dest"
    tar -xzf "$workdir/$tarball" -C "$dest"
    [ -f "$dest/mcp/draft-mcp.js" ] || err "release tarball did not contain mcp/draft-mcp.js"

    # Stable `current` symlink so config.toml never has to change on upgrade.
    ln -sfn "$dest" "${INSTALL_ROOT}/current"
    mcp_js="${INSTALL_ROOT}/current/mcp/draft-mcp.js"

    info "wiring $CONFIG ..."
    write_managed_block "$mcp_js"

    [ -d "$dest/skills" ] || err "release tarball did not contain skills/ — it predates #527"

    info "installing skills + broker client ..."
    mkdir -p "$CODEX_HOME/skills" "$CODEX_HOME/scripts"
    # Copy per skill rather than `cp -r skills/. `, so an upgrade replaces this
    # plugin's skills without touching anything else in a shared directory.
    for d in "$dest"/skills/*/; do
        [ -d "$d" ] || continue
        rm -rf "$CODEX_HOME/skills/$(basename "$d")"
        # ${d%/} strips the trailing slash — `cp -R dir/ dest/` copies the
        # directory *contents* into dest, not the directory itself.
        cp -R "${d%/}" "$CODEX_HOME/skills/"
    done
    cp "$dest"/scripts/foundry-registry.js "$CODEX_HOME/scripts/"

    # Upgrading from a pre-#527 install: Codex no longer reads ~/.codex/prompts,
    # so leaving these behind is dead weight that looks like a working install.
    for s in foundry-agents foundry-queue foundry-refresh foundry-watch foundry-work \
             draft-agents draft-queue draft-refresh draft-watch draft-work; do
        rm -f "$CODEX_HOME/prompts/$s.md"
    done
    rmdir "$CODEX_HOME/prompts" 2>/dev/null || true

    printf '\n'
    info "Done. Next steps:"
    info "  • Export your workspace agent key in your shell profile:"
    info "        export FOUNDRY_API_KEY=fdrk_..."
    info "    (self-hosted Foundry only) also: export FOUNDRY_API_URL=https://your-foundry-host"
    info "  • The legacy DRAFT_API_KEY / DRAFT_API_URL names still work if you"
    info "    already have them exported — no need to change anything."
    info "  • Restart Codex, then try:  /foundry-queue"
    info "  • Uninstall:  curl -fsSL https://dl.foundryworks.dev/install-codex.sh | sh -s -- --uninstall"
}

main "$@"
