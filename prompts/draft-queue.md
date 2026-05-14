---
description: Show the Foundry/Draft agent queue — a read-only snapshot of the stories waiting to be worked.
---

Read-only. Do not claim, start, or modify any story.

1. Call the `queue` tool from the `draft` MCP server. It reads
   `DRAFT_API_KEY` / `DRAFT_API_URL` from the environment; if the call
   reports the key is unset, tell me and stop.
2. Summarize the stories that still need work (i.e. not yet finished
   or accepted): story number, type, state, points, and title — in the
   queue's priority order.
3. Stop there. To actually pick something up, run
   `/prompts:draft-work`.
