#!/usr/bin/env node
// Handoff token reporting (#660).
//
// A handoff is an owner PATCH through update_story, with no transition. Token
// spend used to be reported only on `finish`, so the agent that handed a story
// on was never credited. These tests run the real mcp/draft-mcp.js over stdio
// against a stub Draft API, with a fake session transcript whose usage grows
// between claim and handoff, and assert exactly what reaches the API.
//
// The point to keep: the token fields ride in the SAME request as the owner
// change. One request means a refused handoff records nothing, and the server
// files the numbers under the caller's own row (#540) regardless of owner.
//
// The transcript format is the host's (Claude Code JSONL, or a Codex rollout);
// the server source says which one it reads. Zero dependencies:
// `node scripts/test-handoff-tokens.js`.
"use strict";

const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("assert");

const SERVER = path.join(__dirname, "..", "mcp", "draft-mcp.js");
const CODEX = /CODEX_HOME/.test(fs.readFileSync(SERVER, "utf8"));

const P = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ---- a fake session the server will find as "current" -------------------

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-660-")));
const cwd = path.join(home, "work");
fs.mkdirSync(cwd);

let transcript;
if (CODEX) {
  const dir = path.join(home, ".codex", "sessions", "2026", "11", "03");
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, `rollout-2026-11-03T00-00-00-${SESSION}.jsonl`);
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { session_id: SESSION, cwd } }) + "\n",
  );
} else {
  const dir = path.join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, "");
}

// Cumulative usage so far, mirrored into whichever format the host writes.
// Codex rollouts carry a running total; Claude transcripts carry per-message
// usage the server sums. Both end up at the same cumulative numbers.
const total = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
function spend(input, output, cacheRead, cacheCreation) {
  total.input += input;
  total.output += output;
  total.cache_read += cacheRead;
  total.cache_creation += cacheCreation;
  let row;
  if (CODEX) {
    // Codex has no cache-creation category; it lands in neither field.
    row = {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: total.input + total.cache_read,
            cached_input_tokens: total.cache_read,
            output_tokens: total.output,
            total_tokens: total.input + total.cache_read + total.output,
          },
        },
      },
    };
  } else {
    row = {
      message: {
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
      },
    };
  }
  fs.appendFileSync(transcript, JSON.stringify(row) + "\n");
}

// What the server should report for spend(i, o, r, c) made after a claim.
function expectedFor(i, o, r, c) {
  if (CODEX) {
    return {
      agent_tokens_used: i + o + r,
      agent_input_tokens: i,
      agent_output_tokens: o,
      agent_cache_read_tokens: r,
      agent_cache_creation_tokens: 0,
    };
  }
  return {
    agent_tokens_used: i + o + r + c,
    agent_input_tokens: i,
    agent_output_tokens: o,
    agent_cache_read_tokens: r,
    agent_cache_creation_tokens: c,
  };
}

// ---- stub API -------------------------------------------------------------

const seen = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const payload = req.url === "/v1/auth/me" ? { user: { id: ME } } : { ok: true };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
const patches = () => seen.filter((r) => r.method === "PATCH");

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  ok   " + name);
    pass++;
  } catch (e) {
    console.log("  FAIL " + name + "\n       " + String(e.message).split("\n").join("\n       "));
    fail++;
  }
}

function startServer(apiUrl) {
  const child = spawn(process.execPath, [SERVER, "--server-key=foundry"], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CODE_SESSION_ID: CODEX ? "" : SESSION,
      FOUNDRY_API_URL: apiUrl,
      FOUNDRY_API_KEY: "fdrk_test_key",
      DRAFT_API_URL: "",
      DRAFT_API_KEY: "",
      FOUNDRY_MODEL: "test-model",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p(msg);
      }
    }
  });
  let next = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error("no reply to " + method)), 5000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args) => {
    const m = await rpc("tools/call", { name, arguments: args });
    // Liveness: a tool that errored before reaching the API would leave
    // every "nothing was reported" assertion below passing for free.
    assert.ok(!m.error && !(m.result && m.result.isError), `${name} failed: ${JSON.stringify(m)}`);
    return m;
  };
  return { child, rpc, call };
}

// Claim story n in a fresh state, with prior spend so the baseline is non-zero.
async function claimed(srv, n) {
  spend(1000, 100, 5000, 50);
  seen.length = 0;
  await srv.call("claim_story", { project_id: P, number: n });
  seen.length = 0;
}

(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const srv = startServer(`http://127.0.0.1:${stub.address().port}`);
  await srv.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  console.log(`host transcript format: ${CODEX ? "codex rollout" : "claude code jsonl"}`);

  await test("handoff to another agent reports spend since claim in the same PATCH", async () => {
    await claimed(srv, 1);
    spend(300, 40, 2000, 7);
    const patch = { owner_id: OTHER, eligible_agent_user_ids: [OTHER] };
    await srv.call("update_story", { project_id: P, number: 1, patch });
    const ps = patches();
    assert.strictEqual(ps.length, 1, `expected one PATCH, saw ${ps.length}: ${JSON.stringify(ps)}`);
    assert.strictEqual(ps[0].url, `/v1/projects/${P}/stories/1`);
    assert.deepStrictEqual(ps[0].body, { ...expectedFor(300, 40, 2000, 7), ...patch });
  });

  await test("after a handoff, finish on the same story reports nothing more", async () => {
    // The handoff consumed the claim's snapshot. If it were kept, a later
    // finish would credit this session's unrelated spend to the story.
    spend(999, 99, 9999, 9);
    seen.length = 0;
    await srv.call("transition_story", { project_id: P, number: 1, action: "finish" });
    assert.strictEqual(patches().length, 0, JSON.stringify(seen));
    assert.ok(seen.some((r) => r.method === "POST" && r.url.endsWith("/stories/1/transitions")));
  });

  await test("owner_id: null (unassign) also reports", async () => {
    await claimed(srv, 2);
    spend(10, 20, 30, 40);
    await srv.call("update_story", { project_id: P, number: 2, patch: { owner_id: null } });
    const ps = patches();
    assert.strictEqual(ps.length, 1);
    assert.deepStrictEqual(ps[0].body, { ...expectedFor(10, 20, 30, 40), owner_id: null });
  });

  await test("unset owner_id also reports", async () => {
    await claimed(srv, 3);
    spend(11, 22, 33, 44);
    await srv.call("update_story", { project_id: P, number: 3, patch: { unset: ["owner_id"] } });
    const ps = patches();
    assert.strictEqual(ps.length, 1);
    assert.deepStrictEqual(ps[0].body, { ...expectedFor(11, 22, 33, 44), unset: ["owner_id"] });
  });

  await test("a patch that doesn't touch owner_id is sent untouched", async () => {
    await claimed(srv, 4);
    spend(50, 5, 500, 5);
    await srv.call("update_story", { project_id: P, number: 4, patch: { points: 3 } });
    const ps = patches();
    assert.strictEqual(ps.length, 1);
    assert.deepStrictEqual(ps[0].body, { points: 3 });
  });

  await test("assigning the story to myself is not a handoff", async () => {
    seen.length = 0;
    await srv.call("update_story", { project_id: P, number: 4, patch: { owner_id: ME } });
    const ps = patches();
    assert.strictEqual(ps.length, 1);
    assert.deepStrictEqual(ps[0].body, { owner_id: ME });
  });

  await test("...and the claim is still live, so finish reports the full spend", async () => {
    seen.length = 0;
    await srv.call("transition_story", { project_id: P, number: 4, action: "finish" });
    const ps = patches();
    assert.strictEqual(ps.length, 1, JSON.stringify(seen));
    assert.deepStrictEqual(ps[0].body, expectedFor(50, 5, 500, 5));
  });

  await test("caller-supplied token fields are not overwritten", async () => {
    await claimed(srv, 5);
    spend(70, 7, 700, 7);
    const patch = { owner_id: OTHER, agent_tokens_used: 12345 };
    await srv.call("update_story", { project_id: P, number: 5, patch });
    const ps = patches();
    assert.strictEqual(ps.length, 1);
    assert.deepStrictEqual(ps[0].body, patch);
  });

  await test("a story not claimed in this session hands off with no token fields", async () => {
    seen.length = 0;
    const patch = { owner_id: OTHER };
    await srv.call("update_story", { project_id: P, number: 99, patch });
    const ps = patches();
    assert.strictEqual(ps.length, 1);
    assert.deepStrictEqual(ps[0].body, patch);
  });

  srv.child.kill();
  stub.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
