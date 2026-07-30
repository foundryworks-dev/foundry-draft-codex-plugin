# Draft — ChatGPT Codex integration

Connects a [ChatGPT Codex](https://developers.openai.com/codex/) CLI
session to a [Foundry/Draft](https://app.foundryworks.dev) workspace
so an agent can see the work queue and pick up tickets.

It's the Codex counterpart to the
[Claude Code plugin](https://github.com/foundryworks-dev/foundry-draft-cc-plugin) —
same capabilities, expressed in Codex's idioms.

## How this differs from the Claude Code plugin

Codex has no plugin/marketplace system and no session-start hook, so
this isn't a packaged "plugin" — it's three pieces you wire into your
Codex home directory:

| Piece | Claude Code | Codex |
| --- | --- | --- |
| API access | MCP server (bundled) | **same MCP server** — `mcp/draft-mcp.js`, registered in `~/.codex/config.toml` |
| Commands | `/foundry-*` skills | skills in `~/.codex/skills/` → `/foundry-work`, `/foundry-watch`, `/foundry-queue`, `/foundry-refresh` |
| "Draft is connected" notice | `SessionStart` hook | no equivalent — an optional `~/.codex/AGENTS.md` snippet (see `AGENTS.snippet.md`) |

The MCP server is byte-for-byte the same one the Claude Code plugin
ships — MCP is a standard protocol, so it's portable. (For now it's
copied into this repo; it may be extracted to a shared package later.)

> **Token-tracking note.** The MCP server's `claim_story` and
> `transition_story` tools auto-PATCH a story's `agent_tokens_used`
> field on the finish transition by reading the agent session's
> transcript file. Today that reader only knows the Claude Code
> transcript path (`~/.claude/projects/…`), so in a Codex session
> the bookkeeping gracefully short-circuits and leaves the field
> null. When the Codex CLI exposes its own session-token totals in
> a stable on-disk location, the same code path picks it up — only
> the transcript locator needs swapping. Until then, Codex users
> can still PATCH `agent_tokens_used` themselves via `update_story`
> if they have a count to record.

## Install

```bash
curl -fsSL https://dl.foundryworks.dev/install-codex.sh | sh
```

That's the Codex equivalent of "/plugin install": it fetches a
versioned, SHA-256-verified plugin tarball from `dl.foundryworks.dev`
(no `git clone`), installs it to `~/.foundry/codex-draft-plugin/<version>`
(with a `current` symlink for clean upgrades), and idempotently wires a
`[mcp_servers.draft]` block into `~/.codex/config.toml` — inside a marked
`# BEGIN/END foundry-draft` block, so re-running upgrades in place and
your other config is never touched. Skills and the registry broker
client go into `~/.codex/skills/` and `~/.codex/scripts/`.

Pin a version with `FOUNDRY_CODEX_VERSION=v0.1.0`, or uninstall with:

```bash
curl -fsSL https://dl.foundryworks.dev/install-codex.sh | sh -s -- --uninstall
```

### Upgrading from the `draft-` prompts

The prompts were `/prompts:draft-work`, `/prompts:draft-queue` and so on.
They were renamed to `foundry-*` by #476, and became **skills** in #527 —
Codex stopped reading `~/.codex/prompts` entirely, so they are now
`/foundry-*`.

Re-running the installer copies the new skills in and removes the old
prompt files, which no longer do anything: as of #527 Codex reads
`~/.codex/skills/<name>/SKILL.md` and does **not** read a `prompts/`
directory at all. Any `~/.codex/prompts/draft-*.md` or `foundry-*.md` you
still have are inert — the installer deletes the ones it wrote, and you
can remove the rest:

```bash
rm -f ~/.codex/prompts/{draft,foundry}-{work,watch,queue,refresh,agents}.md
```

The MCP tools are unaffected; they still answer under both the `foundry`
and `draft` server names.

Nothing else moved: `DRAFT_API_KEY` / `DRAFT_API_URL`, the
`[mcp_servers.draft]` registration, and the `draft.foundryworks.dev` host
are all still supported.

### From a clone (development)

```bash
git clone https://github.com/foundryworks-dev/foundry-draft-codex-plugin
cd foundry-draft-codex-plugin
./scripts/install.sh
```

`scripts/install.sh` wires the config to point at your clone (rather than
a downloaded release) — handy when hacking on the plugin. Both installers
are idempotent.

**Requirement:** the MCP server is a Node script — Node 18+ must be on
`PATH` (it uses the built-in `fetch`). No npm dependencies, no build
step.

### Manual install

If you'd rather wire it up yourself:

1. Copy each `skills/foundry-*/` directory into `~/.codex/skills/`.
2. Add this to `~/.codex/config.toml` (use the absolute path to your
   clone):

   ```toml
   [mcp_servers.draft]
   command = "node"
   args = ["/absolute/path/to/foundry-draft-codex-plugin/mcp/draft-mcp.js"]
   env_vars = ["FOUNDRY_API_KEY", "FOUNDRY_API_URL", "DRAFT_API_KEY", "DRAFT_API_URL"]
   ```

   `env_vars` forwards those variables from your shell environment, so
   the key never has to be written into the config file. (`codex mcp
   add` is an alternative, but it sets fixed env values rather than
   forwarding them — the TOML block above is the recommended path.)

## Configure

Set these in your shell profile. **Never commit the API key.**

| Variable        | Required | Default                          | Purpose                                    |
| --------------- | -------- | -------------------------------- | ------------------------------------------ |
| `FOUNDRY_API_KEY` | yes      | —                                | Your workspace agent API key (`fdrk_…`).   |
| `FOUNDRY_API_URL` | no       | `https://app.foundryworks.dev` | Override for a self-hosted Draft instance. |

**The `DRAFT_API_KEY` / `DRAFT_API_URL` names are still accepted** and are
not going away. `FOUNDRY_*` wins when both are set; otherwise `DRAFT_*` is
used and the plugin prints a one-line notice on stderr. Existing setups need
no change (#456).

Get an API key from your Draft workspace under **Settings → Agents**.

### Tool names: `foundry` and `draft`

The plugin registers the MCP server under **two keys**, so both tool
namespaces resolve to the same handler:

| Namespace | Status |
| --------- | ------ |
| `mcp__foundry__*` | the name to use going forward |
| `mcp__draft__*`   | still works; retired only once usage telemetry says nobody calls it (#458) |

The prefix comes from the **client-side config key**, not from anything the
server returns — `tools/list` hands back bare tool names like `queue`. So
aliasing a namespace means mounting the same script twice. The cost is that
every tool appears twice in a session's tool list; that is inherent to MCP
namespacing, not something the server can dedupe (#457).

Each registration passes its own `--server-key=` so the process knows which
namespace it is serving — without it the two are indistinguishable, since
`tools/list` returns bare names either way.

### What gets reported about legacy names (#458)

`draft.` / `DRAFT_*` / `draft:` are supported indefinitely, so retiring any of
them has to be a decision backed by evidence rather than a guess. To make that
possible, requests carry an `X-Foundry-Legacy` header naming the legacy names
**this process is running on** — the `DRAFT_*` variables that supplied its
config, and `prefix=draft` when invoked under the legacy namespace. The server
logs those against your agent identity.

It is names only: no credential, no arguments, no story content, and nothing
at all is sent by a session already on `FOUNDRY_*` and `mcp__foundry__*`.


## Use

After install + restart, in a Codex session:

- **`/foundry-queue`** — show the stories waiting in your agent
  queue (read-only).
- **`/foundry-work`** — work the queue: claim the top story,
  implement it, and finish it. Pass `STORY=<number>` to pick up a
  specific story instead of the top of the queue.
- **`/foundry-watch`** — the same loop, but an empty queue means
  wait and re-check rather than stop. Start it once and leave it: it
  polls until you interrupt. Pass a number of seconds to change the
  interval (default 300).
- **`/foundry-refresh`** — re-fetch Draft's authoritative
  operating instructions (the workspace context) from the API and adopt
  them as canonical for the rest of the session (read-only). Handy for a
  long-running session when the workflow rules may have changed
  server-side.
- **`/foundry-agents`** — pick an agent key from the **Foundry
  Agent Registry** instead of exporting one by hand. When the local
  `foundry daemon` is running and `FOUNDRY_API_KEY` is unset, this lists
  the keys in a table — a Cross-Project column (workspace-level agents)
  and a Project column (project-scoped agents), plus availability — you
  choose one, and the plugin claims it for the session via the
  daemon. If `FOUNDRY_API_KEY` is already set, the registry flow is
  skipped entirely. `install.sh` places the broker client at
  `~/.codex/scripts/foundry-registry.js`. (Codex has no session-end
  hook, so release the key with the broker's `release` when done — the
  daemon/server idle auto-release is the backstop.)

## MCP tools

The `draft` MCP server exposes:

| Tool                | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `whoami`            | The authenticated agent's identity.                             |
| `context`           | Draft's authoritative how-to-operate instructions.              |
| `queue`             | The agent work queue across all reachable projects.             |
| `get_story`         | One story by project id + number.                              |
| `list_comments`     | A story's comment thread.                                       |
| `story_activity`    | A story's activity timeline.                                    |
| `claim_story`       | Claim ownership (resolves your own user id).                    |
| `transition_story`  | Move a story through its state machine (start/finish/block/…).  |
| `comment`           | Post a comment on a story.                                      |
| `add_link`          | Attach a PR/commit URL to a story.                              |
| `create_story`      | File a new story (lands in the backlog for triage).             |
| `update_story`      | Patch arbitrary story fields (points, labels, …).               |
| `library_write`     | Create or update a Library wiki page by (project, slug).        |

## Layout

```
mcp/draft-mcp.js        zero-dependency MCP server wrapping the Draft API
skills/foundry-work/SKILL.md    /foundry-work    — the ticket-working loop
skills/foundry-watch/SKILL.md   /foundry-watch   — the loop, but it keeps polling
skills/foundry-queue/SKILL.md   /foundry-queue   — read-only queue view
skills/foundry-refresh/SKILL.md /foundry-refresh — re-pull the workflow context
scripts/install.sh      copies prompts + wires up config.toml
AGENTS.snippet.md       optional ~/.codex/AGENTS.md "Draft is connected" note
```

## License

MIT — see [LICENSE](LICENSE).
