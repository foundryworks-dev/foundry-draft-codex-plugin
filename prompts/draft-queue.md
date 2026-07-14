---
description: Show the Foundry/Draft agent queue — a read-only snapshot of the stories waiting to be worked.
---

Read-only. Do not claim, start, or modify any story.

1. Call the `queue` tool from the `draft` MCP server. It reads
   `DRAFT_API_KEY` / `DRAFT_API_URL` from the environment. If the key is
   unset, resolve it from the registry:
   `node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" resolve`
   prints `DRAFT_API_KEY<TAB>DRAFT_API_URL` (env if set, else a lease
   claimed via `/prompts:draft-agents`) — use it over REST. If that exits
   non-zero, tell me to run `/prompts:draft-agents` or export
   `DRAFT_API_KEY`, and stop.
2. Summarize the stories that still need work (i.e. not yet finished
   or accepted): story number, type, state, points, and title — in the
   queue's priority order.
3. Stop there. To actually pick something up, run
   `/prompts:draft-work`.
