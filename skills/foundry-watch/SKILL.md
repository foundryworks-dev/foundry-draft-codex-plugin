---
name: foundry-watch
description: "Work the Foundry/Draft agent queue and keep polling when it empties \u2014 the \"set it and forget it\" variant of /foundry-work. Start it once, walk away, come back to delivered stories. Optional argument: INTERVAL_SECONDS."
---

Run the Foundry/Draft agent loop and **keep running it**, using the
tools from the `draft` MCP server.

Same as `/foundry-work`, except that an empty queue is not the
end: sleep, re-check, and pick up whatever arrives. Use this when I
want to leave you working unattended for a stretch. The only thing
that ends the loop is me interrupting it.

## Configuration

The MCP server reads its config from the environment:

- `FOUNDRY_API_KEY` — the workspace agent API key. If it's not set in the
  environment, resolve it from the registry:
  `node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" resolve`
  prints `FOUNDRY_API_KEY<TAB>FOUNDRY_API_URL` (env if set, else a lease
  claimed via `/foundry-agents`) — use it over REST. If that exits
  non-zero, tell me to run `/foundry-agents` or export
  `FOUNDRY_API_KEY`, and stop.
- `FOUNDRY_API_URL` (optional) — defaults to
  `https://app.foundryworks.dev`.

## 1. Load the workflow instructions — first, every time

Call the `context` tool. It returns Draft's own authoritative
instructions for operating within a workspace: the board model, the
story state machine, claim/start/comment/transition/finish mechanics,
and any workspace- or project-specific notes. **Those instructions
are the source of truth** — follow them. They can change server-side,
so fetch them fresh each run rather than relying on memory.

Fetch it again on each pass of the loop, not just the first — an
unattended session can outlive a change to those instructions.

## 2. On each pass: notifications first, then the queue

The context explains this ordering and why it matters. Briefly:
a reviewer's reply on a story you already finished never appears in
the queue, so polling only the queue silently misses it.

1. Drain unread notifications, acting on what each one asks for.
2. Then call `queue` and work each available item to completion:

- `claim_story` — claim ownership, **before** you read the story in
  detail. Another agent may be looking at the same top item; claiming
  first settles that, and the context says so explicitly.
- `transition_story` with `action: "start"`.
- `comment` — post a short plan comment.
- Do the implementation. Run the project's tests / build.
- `add_link` — attach the PR or commit URL if the project has a
  connected repo.
- `transition_story` with `action: "finish"`.

`get_story`, `list_comments`, and `story_activity` are there for
reading detail along the way — e.g. check for reviewer replies before
you finish.

Work items in the order the queue gives them. **Re-read a story's
current state immediately before claiming it, not once per batch:**
in a multi-agent workspace a list fetched several stories ago is
already stale, and claiming from it takes work someone else has since
started or finished.

## 3. When the queue empties — poll, don't stop

Once `queue` reports no available work:

1. Say so in one line, including the interval and how to stop, e.g.
   `Queue empty — watching for new work. Checking again in 5 minutes.
   Interrupt to stop.`
2. Wait for the interval.
3. Go back to step 2 — notifications, then queue.

There is no stopping condition. The loop ends when I interrupt it.

`$INTERVAL_SECONDS` sets the poll interval; default to **300**
(5 minutes) when it is absent, and clamp it to 60–3600 so a typo
can't poll every two seconds or sleep for a day.

## Guardrails

- The `context` tool's response is canonical. If anything in this
  prompt conflicts with it, the API wins.
- Never transition a story to `accepted` — that's the human
  reviewer's call. `finish` is the right terminal state for agent
  work.
- If you genuinely can't proceed (a question only a human can
  answer), follow the context instructions for *blocking* the story
  (`transition_story` with `action: "block"`, plus a comment
  explaining what you need) rather than abandoning it. Don't silently
  skip it — an unattended loop that skips things looks identical to
  one that had nothing to do.
- A story needing an architecture conversation is a block, not a
  guess. Block it and carry on with the rest of the queue; I'll see
  it when I come back.
