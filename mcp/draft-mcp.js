#!/usr/bin/env node
// Foundry/Draft MCP server.
//
// Wraps the Draft workspace API as MCP tools. Zero dependencies: it
// implements the MCP stdio transport (JSON-RPC 2.0 over
// newline-delimited stdin/stdout) directly, and uses the Node 18+
// global `fetch` for HTTP. No build step, no `npm install` — the
// plugin can run it straight from source.
//
// Config (environment):
//   FOUNDRY_API_KEY / DRAFT_API_KEY  required — workspace agent API key (fdrk_…)
//   FOUNDRY_API_URL / DRAFT_API_URL  optional — defaults to
//                                    https://draft.foundryworks.dev
//
// Foundry is a suite now, so the FOUNDRY_* names are the ones to reach
// for. The DRAFT_* names keep working indefinitely (#456) — they're
// exported in operator shells and baked into agent configs we don't
// control, and a host redirect can't paper over an env var rename.
//
// The server starts fine even without a key; tool *calls* then fail
// with a clear, actionable error, so `tools/list` stays discoverable.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// FOUNDRY_* wins → else the legacy DRAFT_* name → else the built-in
// default. Every legacy name that actually supplied a value is recorded:
// once for the stderr notice below, and once per request for the
// retirement signal the server logs (#458).
const legacyEnvNames = [];
function resolveEnv(suffix, fallback) {
  const preferred = process.env[`FOUNDRY_${suffix}`];
  if (preferred) return preferred;
  const legacy = process.env[`DRAFT_${suffix}`];
  if (legacy) {
    legacyEnvNames.push(`DRAFT_${suffix}`);
    return legacy;
  }
  return fallback;
}

const API_URL = resolveEnv("API_URL", "https://draft.foundryworks.dev").replace(
  /\/+$/,
  "",
);
const API_KEY = resolveEnv("API_KEY", "");

// Once per process, never per request (#456). It has to go to stderr:
// stdout is the MCP JSON-RPC channel, and a stray line there corrupts
// the stream for the client.
if (legacyEnvNames.length) {
  process.stderr.write(
    `notice: using ${legacyEnvNames[0]} (and any other DRAFT_* names). The ` +
      `FOUNDRY_* equivalents are preferred; DRAFT_* keeps working.\n`,
  );
}

// Which MCP key this process was mounted under (#458). The tool
// namespace a client exposes — mcp__foundry__queue vs mcp__draft__queue —
// comes from the client-side config key, and `tools/list` hands back bare
// names, so the server cannot otherwise tell which namespace it is
// serving. #457 mounts the same script twice; each registration passes
// its own key here so the two processes are distinguishable.
//
// Unset (an older config written before this landed, or a hand-rolled
// registration) means "don't report" rather than "assume legacy" —
// guessing would put a retirement decision on invented evidence.
const SERVER_KEY = (() => {
  const flag = process.argv.slice(2).find((a) => a.startsWith("--server-key="));
  return flag ? flag.slice("--server-key=".length).trim() : "";
})();

// The legacy names this process is actually running on, reported to the
// API so the server can log them against the agent's identity (#458). A
// process fully on the new names sends nothing at all.
function legacyHeaders() {
  const parts = legacyEnvNames.map((n) => `env=${n}`);
  if (SERVER_KEY === "draft") parts.push("prefix=draft");
  return parts.length ? { "X-Foundry-Legacy": parts.join(",") } : {};
}

const SERVER_INFO = { name: "draft", version: "0.6.0" };
// Echoed back to the client when it doesn't send its own preferred
// protocol version in `initialize`.
const DEFAULT_PROTOCOL = "2025-06-18";

// ---------------------------------------------------- token tracking (#135)
//
// Auto-record how many LLM tokens the agent spent on each story by
// snapshotting the cumulative-token count at claim time and PATCHing
// the diff to `agent_tokens_used` on the finish transition. The
// snapshot lives in a small per-session JSON file under
// ~/.claude/foundry-draft-plugin/ so the bookkeeping survives
// multiple tool calls within a session and stays isolated when
// several Claude Code sessions run in parallel.
//
// Robust to running outside Claude Code: if there's no transcript
// to read, every step short-circuits to a no-op (no snapshot, no
// PATCH at finish), and the rest of the plugin keeps working.
//
// Restart caveat (accepted in the story discussion): if the agent
// process is killed mid-story and a fresh session resumes, the
// snapshot file is keyed by the OLD session id; the new session
// can't see it. We re-snapshot on the spot at finish and just
// report what the current session contributed. Under-reports
// rather than mis-reports.

const STATE_DIR = path.join(
  os.homedir(),
  ".claude",
  "foundry-draft-plugin",
);

// Transcript files live at:
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// where <encoded-cwd> is the absolute working directory with every
// "/" replaced by "-". Claude Code writes one assistant-message row
// per line, with a `message.usage` object on each one.
function transcriptDirForCwd(cwd) {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    cwd.replace(/\//g, "-"),
  );
}

// Identify the transcript for the session that invoked us. Claude Code
// sets CLAUDE_CODE_SESSION_ID in the MCP subprocess's environment and
// writes that session's transcript to <session-id>.jsonl, so we resolve
// that exact file. The old approach — "the most-recently-modified
// .jsonl in the cwd-derived dir" — mis-fires whenever a stale or
// concurrent transcript is newer than the active one (or the active
// transcript lives under a dir that doesn't match process.cwd()): claim
// and finish then read the same wrong file, the diff is ~0, and the
// story records 0 tokens (#248). We only fall back to that heuristic
// when the env var is absent (older Claude Code / non-Claude hosts).
// Returns null when nothing resolves (e.g. running outside Claude Code).
function currentSession() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) {
    // Prefer the transcript under the cwd-derived dir, then search all
    // project dirs (covers a cwd that doesn't match the launch dir,
    // e.g. git worktrees). If the env var is set but no transcript is
    // found, return null rather than guessing a wrong file — under-
    // reporting beats mis-reporting.
    const direct = path.join(
      transcriptDirForCwd(process.cwd()),
      `${sessionId}.jsonl`,
    );
    if (isFile(direct)) return { sessionId, path: direct };
    return findTranscriptById(sessionId);
  }
  return mostRecentSession();
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Search every ~/.claude/projects/<encoded-cwd>/ dir for <id>.jsonl.
// Used when the active transcript isn't under the dir process.cwd()
// encodes to (e.g. the agent launched from a git worktree).
function findTranscriptById(sessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, `${sessionId}.jsonl`);
    if (isFile(candidate)) return { sessionId, path: candidate };
  }
  return null;
}

// Legacy fallback: pick the most-recently-modified .jsonl in the
// cwd-derived transcript dir. Only used when CLAUDE_CODE_SESSION_ID is
// unavailable. Returns null when there's nothing to read.
function mostRecentSession() {
  let entries;
  try {
    entries = fs.readdirSync(transcriptDirForCwd(process.cwd()));
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(transcriptDirForCwd(process.cwd()), name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      best = { sessionId: name.slice(0, -".jsonl".length), path: full };
    }
  }
  return best;
}

// Sum each token category across every row in the transcript that
// carries a usage object. Returns a snapshot of cumulative session
// spend split by type, plus the aggregate. Including cache_read
// keeps the aggregate monotonically matching the "size of work"
// figure billing would show, even though cache_read is functionally
// free per call.
//
// Tolerant of partial / in-flight writes: a malformed trailing line
// is skipped silently. Returns null when the file can't be read at
// all.
function readTokenSnapshot(transcriptPath) {
  let data;
  try {
    data = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const snap = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
  };
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const u = row && row.message && row.message.usage;
    if (!u) continue;
    snap.input += u.input_tokens || 0;
    snap.output += u.output_tokens || 0;
    snap.cache_read += u.cache_read_input_tokens || 0;
    snap.cache_creation += u.cache_creation_input_tokens || 0;
  }
  snap.total =
    snap.input + snap.output + snap.cache_read + snap.cache_creation;
  return snap;
}

function snapshotFileFor(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

function loadSnapshots(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(snapshotFileFor(sessionId), "utf8"));
  } catch {
    return {};
  }
}

function saveSnapshots(sessionId, snapshots) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      snapshotFileFor(sessionId),
      JSON.stringify(snapshots, null, 2),
    );
  } catch (e) {
    process.stderr.write(
      "draft-mcp: token snapshot save failed: " +
        ((e && e.message) || e) +
        "\n",
    );
  }
}

function snapshotKey(projectId, number) {
  return `${projectId}:${number}`;
}

// Record the current cumulative session token totals as the baseline
// for a story. Called on claim_story and on restart (per the story
// spec — restart is "treat like a fresh claim"). Stores both the
// aggregate and each typed category (#155) so the finish PATCH can
// report the breakdown the project's Token Usage screen (#154)
// renders. Silently no-ops outside a Claude Code session.
function snapshotClaim(projectId, number) {
  const session = currentSession();
  if (!session) return;
  const snap = readTokenSnapshot(session.path);
  if (snap == null) return;
  const snapshots = loadSnapshots(session.sessionId);
  snapshots[snapshotKey(projectId, number)] = {
    // Legacy "snapshot" key kept in sync with snap.total so a roll-back
    // to a pre-#155 plugin can still finish a claim that this version
    // started.
    snapshot: snap.total,
    snapshot_typed: {
      input: snap.input,
      output: snap.output,
      cache_read: snap.cache_read,
      cache_creation: snap.cache_creation,
    },
    claimed_at: new Date().toISOString(),
  };
  saveSnapshots(session.sessionId, snapshots);
}

// Compute per-category spend since claim and PATCH the aggregate plus
// the typed columns (#138, #155). Drops the snapshot on success —
// only one finish per claim is meaningful. Best-effort: if the PATCH
// fails we log and continue so the actual finish transition still
// happens (recording cost matters less than completing the work).
//
// Backward-compat: a snapshot taken by an older plugin only carries
// the aggregate baseline (`snapshot` key, no `snapshot_typed`). Those
// fall back to the pre-#155 single-field PATCH.
async function patchTokensUsedAtFinish(projectId, number) {
  const session = currentSession();
  if (!session) return;
  const snapshots = loadSnapshots(session.sessionId);
  const entry = snapshots[snapshotKey(projectId, number)];
  if (!entry) return; // story wasn't claimed through this session
  const snap = readTokenSnapshot(session.path);
  if (snap == null) return;

  // Build the patch body. Always send the aggregate. Send each typed
  // field only when both the baseline AND the current snapshot have a
  // value for it — gives us a graceful fallback if anything's missing.
  const body = {
    agent_tokens_used: Math.max(0, snap.total - (entry.snapshot || 0)),
  };
  const typedBase = entry.snapshot_typed;
  if (typedBase) {
    body.agent_input_tokens = Math.max(0, snap.input - (typedBase.input || 0));
    body.agent_output_tokens = Math.max(0, snap.output - (typedBase.output || 0));
    body.agent_cache_read_tokens = Math.max(
      0,
      snap.cache_read - (typedBase.cache_read || 0),
    );
    body.agent_cache_creation_tokens = Math.max(
      0,
      snap.cache_creation - (typedBase.cache_creation || 0),
    );
  }

  try {
    await api("PATCH", `/v1/projects/${projectId}/stories/${number}`, body);
  } catch (e) {
    process.stderr.write(
      "draft-mcp: agent_tokens_used PATCH failed: " +
        ((e && e.message) || e) +
        "\n",
    );
    return; // leave the snapshot in place so a retry could still work
  }
  delete snapshots[snapshotKey(projectId, number)];
  saveSnapshots(session.sessionId, snapshots);
}

// ---------------------------------------------------------------- HTTP

// ---------------------------------------------------------------- MODEL
// Resolve the model this agent is running so the Draft API records it on
// each request (#420 — the client side of #416's X-Foundry-Model capture,
// which populates model history for raw-fdrk_-key agents that never call
// report-usage). Prefer an explicit FOUNDRY_MODEL override; otherwise read
// the most recent message.model from the session transcript (the harness
// records the live model there — e.g. "claude-opus-4-8"). Cached briefly so
// we don't re-read the transcript on every API call.
let modelCache = null; // { model, version, at }
const MODEL_TTL_MS = 30000;

function readModelFromTranscript() {
  const sess = currentSession();
  if (!sess || !sess.path) return "";
  let data;
  try {
    data = fs.readFileSync(sess.path, "utf8");
  } catch {
    return "";
  }
  let model = "";
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row && row.message && row.message.model;
    // Skip Claude Code's synthetic placeholder rows.
    if (m && m !== "<synthetic>") model = m;
  }
  return model;
}

// { model, version } for the current agent, or empty model when unknown.
function resolveModel() {
  const envModel = (process.env.FOUNDRY_MODEL || "").trim();
  const version = (process.env.FOUNDRY_MODEL_VERSION || "").trim();
  if (envModel) return { model: envModel, version };
  const now = Date.now();
  if (modelCache && now - modelCache.at < MODEL_TTL_MS) return modelCache;
  modelCache = { model: readModelFromTranscript(), version, at: now };
  return modelCache;
}

// Header pair the Draft API reads to record the agent's model (#416).
// Omitted entirely when the model can't be resolved — under-reporting
// beats mis-reporting, and the backend treats a blank model as a no-op.
function modelHeaders() {
  const { model, version } = resolveModel();
  if (!model) return {};
  const h = { "X-Foundry-Model": model };
  if (version) h["X-Foundry-Model-Version"] = version;
  return h;
}

async function api(method, path, body) {
  if (!API_KEY) {
    throw new Error(
      "FOUNDRY_API_KEY is not set. Export your Foundry workspace agent " +
        "API key (fdrk_…) before using the tools. (DRAFT_API_KEY is " +
        "still accepted.)",
    );
  }
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      Authorization: "Bearer " + API_KEY,
      ...modelHeaders(),
      ...legacyHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail =
      parsed && parsed.message
        ? parsed.message
        : typeof parsed === "string" && parsed
          ? parsed
          : res.statusText;
    throw new Error(`Draft API ${method} ${path} → ${res.status}: ${detail}`);
  }
  return parsed;
}

// --------------------------------------------------------------- tools
// Each tool: { name, description, inputSchema, run(args) -> any }.
// Tool names are unprefixed — the MCP server key ("draft") already
// namespaces them, so they surface as mcp__draft__<name>.

const idArgs = {
  project_id: { type: "string", description: "The story's project UUID." },
  number: {
    type: "number",
    description: "The story number within its project.",
  },
};

const TOOLS = [
  {
    name: "whoami",
    description:
      "Return the authenticated agent's identity (GET /v1/auth/me) — useful for confirming which account the API key belongs to.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/v1/auth/me"),
  },
  {
    name: "context",
    description:
      "Fetch Draft's authoritative instructions for operating within a workspace: the board model, the story state machine, how to claim/start/comment/transition/finish, and any workspace- or project-specific notes. Read this before working stories — it is the source of truth and can change server-side.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/v1/agent/context"),
  },
  {
    name: "queue",
    description:
      "List the agent work queue across every reachable project — stories marked ready_for_agent that you're eligible for, current iteration first (lower position = higher priority).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/v1/agent/queue"),
  },
  {
    name: "get_story",
    description: "Fetch a single story by project id + story number.",
    inputSchema: {
      type: "object",
      properties: { ...idArgs },
      required: ["project_id", "number"],
    },
    run: (a) =>
      api("GET", `/v1/projects/${a.project_id}/stories/${a.number}`),
  },
  {
    name: "list_comments",
    description:
      "Read the comment thread on a story. Good etiquette before commenting or finishing — a reviewer may have replied while you worked.",
    inputSchema: {
      type: "object",
      properties: { ...idArgs },
      required: ["project_id", "number"],
    },
    run: (a) =>
      api(
        "GET",
        `/v1/projects/${a.project_id}/stories/${a.number}/comments`,
      ),
  },
  {
    name: "story_activity",
    description:
      "Fetch a story's activity timeline — state transitions, owner/points edits, etc.",
    inputSchema: {
      type: "object",
      properties: { ...idArgs },
      required: ["project_id", "number"],
    },
    run: (a) =>
      api(
        "GET",
        `/v1/projects/${a.project_id}/stories/${a.number}/activity`,
      ),
  },
  {
    name: "claim_story",
    description:
      "Claim ownership of a story for the authenticated agent — sets owner_id to your own user id (resolved via /v1/auth/me). Do this before transitioning a queue item to started.",
    inputSchema: {
      type: "object",
      properties: { ...idArgs },
      required: ["project_id", "number"],
    },
    run: async (a) => {
      const me = await api("GET", "/v1/auth/me");
      const userId = me && me.user && me.user.id;
      if (!userId) {
        throw new Error("could not resolve own user id from /v1/auth/me");
      }
      const result = await api(
        "PATCH",
        `/v1/projects/${a.project_id}/stories/${a.number}`,
        { owner_id: userId },
      );
      // #135 — start the token-usage clock for this story. Best-
      // effort: a failed snapshot just means we'll skip the
      // agent_tokens_used PATCH at finish; the claim itself is
      // already done.
      snapshotClaim(a.project_id, a.number);
      return result;
    },
  },
  {
    name: "transition_story",
    description:
      "Move a story through its state machine. Common actions: start, finish, block, unblock, restart, deliver, reject. The server validates the transition and rejects illegal ones. Do not use 'accept' — that's the human reviewer's call.",
    inputSchema: {
      type: "object",
      properties: {
        ...idArgs,
        action: {
          type: "string",
          description:
            "The transition action, e.g. 'start', 'finish', 'block', 'unblock', 'restart'.",
        },
      },
      required: ["project_id", "number", "action"],
    },
    run: async (a) => {
      // #135 — auto-report agent_tokens_used on finish, and re-seed
      // the snapshot on restart so the next finish reports only the
      // post-restart spend. block / unblock / deliver / reject leave
      // the snapshot alone; the snapshot persists across them so a
      // story that finishes after a block-then-unblock cycle still
      // captures total spend since the original claim. The PATCH
      // here runs BEFORE the transition POST so it shows up on the
      // story's activity timeline as part of the work that finished
      // the story, not as a stray edit after delivery.
      if (a.action === "finish") {
        await patchTokensUsedAtFinish(a.project_id, a.number);
      } else if (a.action === "restart") {
        snapshotClaim(a.project_id, a.number);
      }
      return api(
        "POST",
        `/v1/projects/${a.project_id}/stories/${a.number}/transitions`,
        { action: a.action },
      );
    },
  },
  {
    name: "comment",
    description:
      "Post a comment on a story. The body accepts a small set of HTML tags (<strong>, <em>, <code>, <ul>, <li>, <br>) and is sanitized server-side; plain text is fine too.",
    inputSchema: {
      type: "object",
      properties: {
        ...idArgs,
        body: {
          type: "string",
          description: "Comment body — plain text or simple HTML.",
        },
      },
      required: ["project_id", "number", "body"],
    },
    run: (a) =>
      api(
        "POST",
        `/v1/projects/${a.project_id}/stories/${a.number}/comments`,
        { body: a.body },
      ),
  },
  {
    name: "add_link",
    description:
      "Attach a link to a story — typically a GitHub PR or commit URL once your work is up.",
    inputSchema: {
      type: "object",
      properties: {
        ...idArgs,
        url: { type: "string", description: "The URL to attach." },
      },
      required: ["project_id", "number", "url"],
    },
    run: (a) =>
      api("POST", `/v1/projects/${a.project_id}/stories/${a.number}/links`, {
        url: a.url,
      }),
  },
  {
    name: "create_story",
    description:
      "File a new story. The server forces it into the backlog as unstarted and unowned — agents file work for humans to triage. Check the board for duplicates first. Optionally attach the story to an epic and/or a release, and stamp created_from_story_id when it's derived from another story.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "The project UUID." },
        type: {
          type: "string",
          description: "feature | bug | chore | spike",
        },
        title: { type: "string" },
        description: {
          type: "string",
          description: "Story description, as HTML.",
        },
        points: {
          type: "number",
          description:
            "Story point estimate. Some projects require one on create.",
        },
        epic_id: {
          type: "string",
          description:
            "Optional epic UUID to file the story under. Look it up from GET /v1/projects/{id}/board (board.epics[].id).",
        },
        release_id: {
          type: "string",
          description:
            "Optional release UUID to scope the story to. Look it up from GET /v1/projects/{id}/board (board.releases[].id).",
        },
        created_from_story_id: {
          type: "string",
          description:
            "Optional source-story UUID recording provenance when this story is derived from another (e.g. an architect breaking a design into implementation stories). Use the parent's id (UUID, not its #number) from GET /v1/projects/{id}/board.",
        },
      },
      required: ["project_id", "type", "title"],
    },
    run: (a) => {
      const body = { type: a.type, title: a.title };
      if (a.description != null) body.description = a.description;
      if (a.points != null) body.points = a.points;
      if (a.epic_id != null) body.epic_id = a.epic_id;
      if (a.release_id != null) body.release_id = a.release_id;
      if (a.created_from_story_id != null)
        body.created_from_story_id = a.created_from_story_id;
      return api("POST", `/v1/projects/${a.project_id}/stories`, body);
    },
  },
  {
    name: "library_write",
    description:
      "Create or update a Library wiki page by (project, slug). Upsert: creates the page if the slug is new, otherwise appends a new revision. Body is HTML (sanitized server-side); the agent-friendly (L2) and agent-optimized (L3) representations are derived automatically. Requires the project's agents_can_edit_library setting to be enabled.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "The project slug (not UUID) — the same identifier the read/context API uses.",
        },
        slug: {
          type: "string",
          description:
            "URL-safe page slug; the upsert key together with project. Omit to derive it from the title.",
        },
        title: { type: "string", description: "Page title." },
        body: {
          type: "string",
          description: "Page body as HTML; sanitized server-side.",
        },
        change_summary: {
          type: "string",
          description: "Optional edit summary recorded on this revision.",
        },
        parent_slug: {
          type: "string",
          description:
            "Optional slug of an existing page to nest this one under.",
        },
      },
      required: ["project", "title", "body"],
    },
    run: (a) => {
      const body = { project: a.project, title: a.title, body: a.body };
      if (a.slug != null) body.slug = a.slug;
      if (a.change_summary != null) body.change_summary = a.change_summary;
      if (a.parent_slug != null) body.parent_slug = a.parent_slug;
      return api("PUT", "/v1/library/page", body);
    },
  },
  {
    name: "update_story",
    description:
      "Patch fields on a story (points, labels, ready_for_agent, etc.). For claiming ownership prefer claim_story, which resolves your user id for you.",
    inputSchema: {
      type: "object",
      properties: {
        ...idArgs,
        patch: {
          type: "object",
          description:
            'Object of fields to update, e.g. {"points": 3} or {"ready_for_agent": true}.',
        },
      },
      required: ["project_id", "number", "patch"],
    },
    run: (a) =>
      api(
        "PATCH",
        `/v1/projects/${a.project_id}/stories/${a.number}`,
        a.patch,
      ),
  },
];

// ------------------------------------------------------- MCP transport

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no response.
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "initialize") {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "ping") {
    reply(id, {});
    return;
  }

  if (method === "tools/list") {
    reply(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      // Unknown tool name is a caller error → JSON-RPC error.
      replyError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    try {
      const result = await tool.run(args);
      reply(id, {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      });
    } catch (err) {
      // Execution failures are returned as a result with isError, per
      // the MCP spec — the model sees the message and can react.
      reply(id, {
        content: [{ type: "text", text: String((err && err.message) || err) }],
        isError: true,
      });
    }
    return;
  }

  // Anything else: unknown method (only answer if it expects a reply).
  if (id !== undefined) {
    replyError(id, -32601, `method not found: ${method}`);
  }
}

// Newline-delimited JSON on stdin. Buffer across chunks so a message
// split over two reads still parses.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stderr.write("draft-mcp: bad JSON on stdin: " + e.message + "\n");
      continue;
    }
    handle(msg).catch((e) => {
      process.stderr.write(
        "draft-mcp: handler error: " + ((e && e.stack) || e) + "\n",
      );
    });
  }
});
// No explicit exit on stdin 'end'. When the client closes stdin the
// stream unrefs itself; Node then exits on its own once any in-flight
// tool calls have settled and written their responses. Calling
// process.exit() here would kill pending fetches mid-flight.

process.stderr.write(
  `draft-mcp ${SERVER_INFO.version} ready — API ${API_URL}` +
    (API_KEY ? "\n" : " (FOUNDRY_API_KEY not set)\n"),
);
