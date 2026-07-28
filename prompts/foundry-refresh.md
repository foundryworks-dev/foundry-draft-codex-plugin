---
description: Re-fetch Foundry/Draft's authoritative operating instructions (the workspace context) from the API and adopt them as canonical for the rest of the session.
---

Force a fresh pull of Draft's authoritative operating instructions from
the API. The instructions live server-side and **can change**, so this
is how you re-ground a session on the latest rules without restarting
it. Read-only: it claims, starts, and modifies nothing.

1. Call the `context` tool from the `foundry` MCP server. It reads
   `FOUNDRY_API_KEY` / `FOUNDRY_API_URL` from the environment; if the call
   reports the key is unset, tell me and stop. The tool re-fetches the
   board model, the story state machine, the
   claim/start/comment/transition/finish mechanics, the @-mention
   format, the hand-off protocol, and any workspace- or project-specific
   notes straight from the API.
2. Adopt the freshly returned text as canonical, replacing any earlier
   understanding from this session — including anything cached from a
   previous `/prompts:foundry-work` or `/prompts:foundry-refresh` run. If
   the new context conflicts with what you were doing, the new context
   wins.
3. Briefly tell me what (if anything) changed since the context was last
   loaded — e.g. new workspace instructions, a changed transition rule,
   an updated role description — or confirm it's unchanged.

This does not start or continue working the queue. To do that, run
`/prompts:foundry-work` (which loads the context itself before working).
