---
description: Pick and claim an agent key from the local Foundry Agent Registry daemon instead of exporting a FOUNDRY_API_KEY by hand. Lists the keys you may lease grouped by project; you choose one and the plugin claims it for this session.
---

Use this when `FOUNDRY_API_KEY` is **not** already set and you're running the
Foundry Agent Registry daemon (`foundry daemon`). If `FOUNDRY_API_KEY` **is**
set, the registry flow is unnecessary — this session is already keyed; tell me
and stop.

The broker client is `"${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js"`
(installed there by the plugin's `install.sh`). It talks only to the local
daemon over loopback and never handles an operator token.

1. **Confirm the daemon is running:**

   ```
   node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" status
   ```

   Exit code 3 → the daemon isn't running; tell me to start it with
   `foundry daemon &` (and `foundry login` if needed), then stop.

2. **List leasable keys:**

   ```
   node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" keys
   ```

   Prints a table with a **Cross-Project** column (✓ = a workspace-level agent,
   works across every project) and a **Project** column (the team a
   project-scoped agent belongs to), plus availability, env, and a `[PROD]`
   flag. Show me the list and ask which agent to work as. Only `available` keys
   can be claimed; be explicit about `[PROD]` choices.

3. **Claim the chosen key** (with its `key_id` and `env`):

   ```
   node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" claim <key_id> \
     --env <env> --plugin draft-codex --repo "<owner/repo if known>"
   ```

   On success the daemon returns the lease credential; the broker records it in
   `~/.foundry/active-lease.json` (honoring `$FOUNDRY_HOME`) and auto-heartbeats
   it. Tell me which agent + env I'm now working as. A 409 means someone else
   claimed it first — go back to step 2.

4. **Proceed:** `/prompts:draft-queue` and `/prompts:draft-work` resolve the
   credential with
   `node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" resolve`
   (env `FOUNDRY_API_KEY` if set, otherwise the claimed lease) and operate as
   that agent.

**Lifecycle:** Codex has no session-end hook, so release the key when you're
done with
`node "${CODEX_HOME:-$HOME/.codex}/scripts/foundry-registry.js" release`
(the daemon/server idle auto-release reclaims it after the lease TTL if you
forget). A `should_stop: true` from a `usage` report (broker exit code 10)
means the budget is spent — stop taking new work. Never echo the lease token.
