# Draft — ChatGPT Codex integration

Connects a [ChatGPT Codex](https://developers.openai.com/codex/) CLI
session to a [Foundry/Draft](https://draft.foundryworks.dev) workspace
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
| Commands | `/draft:*` skills | custom prompts in `~/.codex/prompts/` → `/prompts:draft-work`, `/prompts:draft-queue` |
| "Draft is connected" notice | `SessionStart` hook | no equivalent — an optional `~/.codex/AGENTS.md` snippet (see `AGENTS.snippet.md`) |

The MCP server is byte-for-byte the same one the Claude Code plugin
ships — MCP is a standard protocol, so it's portable. (For now it's
copied into this repo; it may be extracted to a shared package later.)

## Install

```bash
git clone https://github.com/foundryworks-dev/foundry-draft-codex-plugin
cd foundry-draft-codex-plugin
./scripts/install.sh
```

`install.sh` copies the custom prompts into `~/.codex/prompts/` and
adds a `[mcp_servers.draft]` block to `~/.codex/config.toml` (it skips
the block if you already have one). It's idempotent — re-run it to
refresh the prompts after a `git pull`.

**Requirement:** the MCP server is a Node script — Node 18+ must be on
`PATH` (it uses the built-in `fetch`). No npm dependencies, no build
step.

### Manual install

If you'd rather wire it up yourself:

1. Copy `prompts/*.md` into `~/.codex/prompts/`.
2. Add this to `~/.codex/config.toml` (use the absolute path to your
   clone):

   ```toml
   [mcp_servers.draft]
   command = "node"
   args = ["/absolute/path/to/foundry-draft-codex-plugin/mcp/draft-mcp.js"]
   env_vars = ["DRAFT_API_KEY", "DRAFT_API_URL"]
   ```

   `env_vars` forwards those variables from your shell environment, so
   the key never has to be written into the config file. (`codex mcp
   add` is an alternative, but it sets fixed env values rather than
   forwarding them — the TOML block above is the recommended path.)

## Configure

Set these in your shell profile. **Never commit the API key.**

| Variable        | Required | Default                          | Purpose                                    |
| --------------- | -------- | -------------------------------- | ------------------------------------------ |
| `DRAFT_API_KEY` | yes      | —                                | Your workspace agent API key (`fdrk_…`).   |
| `DRAFT_API_URL` | no       | `https://draft.foundryworks.dev` | Override for a self-hosted Draft instance. |

Get an API key from your Draft workspace under **Settings → Agents**.

## Use

After install + restart, in a Codex session:

- **`/prompts:draft-queue`** — show the stories waiting in your agent
  queue (read-only).
- **`/prompts:draft-work`** — work the queue: claim the top story,
  implement it, and finish it. Pass `STORY=<number>` to pick up a
  specific story instead of the top of the queue.

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

## Layout

```
mcp/draft-mcp.js        zero-dependency MCP server wrapping the Draft API
prompts/draft-work.md   /prompts:draft-work  — the ticket-working loop
prompts/draft-queue.md  /prompts:draft-queue — read-only queue view
scripts/install.sh      copies prompts + wires up config.toml
AGENTS.snippet.md       optional ~/.codex/AGENTS.md "Draft is connected" note
```

## License

MIT — see [LICENSE](LICENSE).
