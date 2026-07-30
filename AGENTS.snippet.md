# Foundry/Draft — AGENTS.md snippet (optional)

Codex has no session-start hook, so there's no exact equivalent of
the Claude Code plugin's "Draft is connected" notice. The closest
thing is your **global** `~/.codex/AGENTS.md`, which Codex reads at
the start of every session.

If you'd like Codex to be aware of the Draft commands, append the
block below to `~/.codex/AGENTS.md`. It's **opt-in** — and note it's
unconditional: unlike the Claude Code hook (which only fired when
`FOUNDRY_API_KEY` was set), this text is in scope for every session in
every repo. Keep it short for that reason, or skip it and just invoke
`/prompts:foundry-work` explicitly when you want it.

```markdown
## Foundry/Draft

If `FOUNDRY_API_KEY` is set in the environment, this machine is wired to
a Foundry/Draft workspace. To see the agent work queue, run
`/prompts:foundry-queue`. To start working tickets from it, run
`/prompts:foundry-work`, or `/prompts:foundry-watch` to keep working as
new tickets arrive. To re-pull the latest workflow instructions
mid-session, run `/prompts:foundry-refresh`. If `FOUNDRY_API_KEY` is *not*
set but a Foundry Agent Registry daemon is running, run
`/prompts:foundry-agents` to pick and claim a key from the registry
first. Do not start working tickets unprompted — wait to be asked.
```
