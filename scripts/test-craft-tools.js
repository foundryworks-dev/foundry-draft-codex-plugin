#!/usr/bin/env node
// Craft tool tests for the MCP server (#666).
//
// Runs the real mcp/draft-mcp.js over stdio against a stub Draft API and
// asserts, for each craft_* tool, the exact method, path and body it sends,
// and what reaches the client. The case that matters most is the image:
// craft_call must hand a screenshot to the client as MCP image content. A
// server that stringified it into a text block would still "work" and every
// request-shaped assertion would pass, so the content type is checked
// directly.
//
// Zero dependencies, like the server: `node scripts/test-craft-tools.js`.
"use strict";

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("assert");

const PNG_B64 = Buffer.from("\x89PNG-test-image").toString("base64");
const P = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

const seen = [];
let respond = () => [200, {}];

const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: body ? JSON.parse(body) : undefined,
    });
    const [status, payload] = respond(req);
    if (status === 204) {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

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
  const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "draft-mcp.js"), "--server-key=foundry"], {
    env: { ...process.env, FOUNDRY_API_URL: apiUrl, FOUNDRY_API_KEY: "fdrk_test_key", DRAFT_API_URL: "", DRAFT_API_KEY: "" },
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
  return { child, rpc, call: (name, args) => rpc("tools/call", { name, arguments: args }) };
}

// Run one tool and return [the one request the stub saw, the MCP result].
async function one(srv, name, args) {
  seen.length = 0;
  const reply = await srv.call(name, args);
  assert.strictEqual(seen.length, 1, `expected exactly one API request, saw ${seen.length}`);
  assert.strictEqual(seen[0].auth, "Bearer fdrk_test_key");
  return [seen[0], reply.result];
}

(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const srv = startServer(`http://127.0.0.1:${stub.address().port}`);
  await srv.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

  await test("tools/list offers the five craft tools", async () => {
    const r = await srv.rpc("tools/list", {});
    const names = r.result.tools.map((t) => t.name);
    for (const n of ["craft_tools", "craft_open", "craft_call", "craft_save", "craft_close"]) {
      assert.ok(names.includes(n), n + " missing from tools/list");
    }
  });

  await test("craft_tools: GET the app's tool list", async () => {
    respond = () => [200, { app: "figcraft", tools: [{ name: "create_node" }] }];
    const [req, res] = await one(srv, "craft_tools", { project_id: P, app: "figcraft" });
    assert.strictEqual(req.method, "GET");
    assert.strictEqual(req.url, `/v1/projects/${P}/crafts/figcraft/tools`);
    assert.strictEqual(req.body, undefined);
    assert.ok(res.content[0].text.includes("create_node"));
  });

  await test("craft_open: POST the story's session with only the given fields", async () => {
    respond = () => [201, { session: { id: SID } }];
    let [req] = await one(srv, "craft_open", { project_id: P, story_number: 7, app: "figcraft" });
    assert.strictEqual(req.method, "POST");
    assert.strictEqual(req.url, `/v1/projects/${P}/stories/7/crafts/figcraft/sessions`);
    assert.deepStrictEqual(req.body, {});
    [req] = await one(srv, "craft_open", {
      project_id: P, story_number: 7, app: "figcraft", document_id: "d-1", read_only: true,
    });
    assert.deepStrictEqual(req.body, { document_id: "d-1", read_only: true });
  });

  await test("craft_call: POST {tool, arguments} and pass image content through as an image", async () => {
    respond = () => [200, { result: { content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] } }];
    const [req, res] = await one(srv, "craft_call", {
      project_id: P, session_id: SID, tool: "screenshot", arguments: { scale: 2 },
    });
    assert.strictEqual(req.method, "POST");
    assert.strictEqual(req.url, `/v1/projects/${P}/crafts/sessions/${SID}/call`);
    assert.deepStrictEqual(req.body, { tool: "screenshot", arguments: { scale: 2 } });
    assert.strictEqual(res.content.length, 1);
    assert.deepStrictEqual(res.content[0], { type: "image", data: PNG_B64, mimeType: "image/png" });
    assert.ok(!res.isError);
  });

  await test("craft_call: a notice comes first, as text; isError is carried over", async () => {
    respond = () => [200, {
      notice: "restored from version 2, unsaved work was lost",
      result: { content: [{ type: "text", text: "no such node" }], isError: true },
    }];
    const [, res] = await one(srv, "craft_call", { project_id: P, session_id: SID, tool: "get_node", arguments: { id: "9" } });
    assert.strictEqual(res.content[0].type, "text");
    assert.ok(res.content[0].text.includes("restored from version 2"));
    assert.strictEqual(res.content[1].text, "no such node");
    assert.strictEqual(res.isError, true);
  });

  await test("craft_call: arguments default to {}", async () => {
    respond = () => [200, { result: { content: [] } }];
    const [req] = await one(srv, "craft_call", { project_id: P, session_id: SID, tool: "undo" });
    assert.deepStrictEqual(req.body, { tool: "undo", arguments: {} });
  });

  await test("craft_call: a policy refusal reaches the agent with its message", async () => {
    respond = () => [403, { error: "craft_refused", rule: "command", message: "command collab.share is not available" }];
    const [, res] = await one(srv, "craft_call", { project_id: P, session_id: SID, tool: "run_command", arguments: { command: "collab.share" } });
    assert.strictEqual(res.isError, true);
    assert.ok(res.content[0].text.includes("collab.share is not available"));
  });

  await test("craft_save: POST the label, or an empty body without one", async () => {
    respond = () => [201, { created: true, version: { seq: 3 } }];
    let [req] = await one(srv, "craft_save", { project_id: P, session_id: SID, label: "v1 layout" });
    assert.strictEqual(req.method, "POST");
    assert.strictEqual(req.url, `/v1/projects/${P}/crafts/sessions/${SID}/save`);
    assert.deepStrictEqual(req.body, { label: "v1 layout" });
    [req] = await one(srv, "craft_save", { project_id: P, session_id: SID });
    assert.deepStrictEqual(req.body, {});
  });

  await test("craft_close: DELETE the session", async () => {
    respond = () => [204];
    const [req, res] = await one(srv, "craft_close", { project_id: P, session_id: SID });
    assert.strictEqual(req.method, "DELETE");
    assert.strictEqual(req.url, `/v1/projects/${P}/crafts/sessions/${SID}`);
    assert.ok(res.content[0].text.includes('"closed": true'));
  });

  await test("ids are one path segment each", async () => {
    respond = () => [200, {}];
    const [req] = await one(srv, "craft_tools", { project_id: "../../v1/auth/me", app: "figcraft" });
    assert.ok(req.url.startsWith("/v1/projects/..%2F..%2Fv1%2Fauth%2Fme/crafts/"), req.url);
  });

  srv.child.kill();
  stub.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
