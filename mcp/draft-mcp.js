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
//   DRAFT_API_KEY  required — workspace agent API key (fdrk_…)
//   DRAFT_API_URL  optional — defaults to https://draft.foundryworks.dev
//
// The server starts fine even without DRAFT_API_KEY; tool *calls*
// then fail with a clear, actionable error, so `tools/list` stays
// discoverable.
"use strict";

const API_URL = (
  process.env.DRAFT_API_URL || "https://draft.foundryworks.dev"
).replace(/\/+$/, "");
const API_KEY = process.env.DRAFT_API_KEY || "";

const SERVER_INFO = { name: "draft", version: "0.1.0" };
// Echoed back to the client when it doesn't send its own preferred
// protocol version in `initialize`.
const DEFAULT_PROTOCOL = "2025-06-18";

// ---------------------------------------------------------------- HTTP

async function api(method, path, body) {
  if (!API_KEY) {
    throw new Error(
      "DRAFT_API_KEY is not set. Export your Foundry/Draft workspace " +
        "agent API key (fdrk_…) before using the draft tools.",
    );
  }
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      Authorization: "Bearer " + API_KEY,
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
      return api("PATCH", `/v1/projects/${a.project_id}/stories/${a.number}`, {
        owner_id: userId,
      });
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
    run: (a) =>
      api(
        "POST",
        `/v1/projects/${a.project_id}/stories/${a.number}/transitions`,
        { action: a.action },
      ),
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
      "File a new story. The server forces it into the backlog as unstarted and unowned — agents file work for humans to triage. Check the board for duplicates first.",
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
      },
      required: ["project_id", "type", "title"],
    },
    run: (a) => {
      const body = { type: a.type, title: a.title };
      if (a.description != null) body.description = a.description;
      if (a.points != null) body.points = a.points;
      return api("POST", `/v1/projects/${a.project_id}/stories`, body);
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
    (API_KEY ? "\n" : " (DRAFT_API_KEY not set)\n"),
);
