---
description: Work the Foundry/Draft agent queue — fetch the workflow context, claim the top story, implement it, and finish it.
argument-hint: [STORY=<number>]
---

Run the Foundry/Draft agent loop, using the tools from the `draft`
MCP server.

## Configuration

The MCP server reads its config from the environment:

- `DRAFT_API_KEY` (required) — the workspace agent API key. If a tool
  call reports it's unset, tell me and stop.
- `DRAFT_API_URL` (optional) — defaults to
  `https://draft.foundryworks.dev`.

## 1. Load the workflow instructions — first, every time

Call the `context` tool. It returns Draft's own authoritative
instructions for operating within a workspace: the board model, the
story state machine, claim/start/comment/transition/finish mechanics,
and any workspace- or project-specific notes. **Those instructions
are the source of truth** — follow them. They can change server-side,
so fetch them fresh each run rather than relying on memory.

## 2. Work the queue

Call the `queue` tool and take the highest-priority item (the context
explains the ordering). Then drive it to completion with the matching
tools, exactly as the context instructions describe:

- `claim_story` — claim ownership (resolves your own user id for you).
- `transition_story` with `action: "start"`.
- `comment` — post a short plan comment.
- Do the implementation. Run the project's tests / build.
- `add_link` — attach the PR or commit URL if the project has a
  connected repo.
- `transition_story` with `action: "finish"`.

`get_story`, `list_comments`, and `story_activity` are there for
reading detail along the way — e.g. check for reviewer replies before
you finish.

If `$STORY` is provided, pick up that story number instead of the top
of the queue.

## 3. Repeat or stop

When the `queue` tool shows no available work, say so and stop.
Otherwise continue to the next item — but check in with me rather than
looping indefinitely if a story turns out far larger than expected or
needs a decision you can't make.

## Guardrails

- The `context` tool's response is canonical. If anything in this
  prompt conflicts with it, the API wins.
- Never transition a story to `accepted` — that's the human
  reviewer's call. `finish` is the right terminal state for agent
  work.
- If you genuinely can't proceed (a question only a human can
  answer), follow the context instructions for *blocking* the story
  (`transition_story` with `action: "block"`, plus a comment
  explaining what you need) rather than abandoning it.
