---
name: foundry-queue
description: "Show the Foundry/Draft agent queue \u2014 a read-only snapshot of the stories waiting to be worked."
---

Read-only. Do not claim, start, or modify any story.

1. Call the `queue` tool from the `foundry` MCP server. It reads
   `FOUNDRY_API_KEY` / `FOUNDRY_API_URL` from the environment. If the key is
   unset, resolve it from the registry:
   `node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" resolve`
   prints `FOUNDRY_API_KEY<TAB>FOUNDRY_API_URL` (env if set, else a lease
   claimed via `/foundry-agents`) — use it over REST. If that exits
   non-zero, tell me to run `/foundry-agents` or export
   `FOUNDRY_API_KEY`, and stop.
2. Summarize the stories that still need work (i.e. not yet finished
   or accepted): story number, type, state, points, and title — in the
   queue's priority order.
3. Stop there. To actually pick something up, run
   `/foundry-work`.
