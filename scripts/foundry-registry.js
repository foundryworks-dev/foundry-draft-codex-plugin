#!/usr/bin/env node
// Foundry Agent Registry broker client (Registry S7, #194).
//
// A thin client for the local `foundry daemon` (Registry S9): the plugins call
// this to pick + claim an agent key instead of being handed a DRAFT_API_KEY by
// hand. The daemon holds the operator's login and owns all the server-side
// lease calls; this client only talks to the daemon's loopback IPC.
//
// Discovery + contract (from the S9 daemon):
//   ~/.foundry/daemon.json  → { base_url, port, token, pid, version }
//   All endpoints except /health need `Authorization: Bearer <token>`.
//     GET  /health                    → { ok, version, pid }
//     GET  /keys                      → { keys: [{ env, is_prod, project, key_id,
//                                          agent_name, name, prefix, availability,
//                                          policy, budget, in_use_by }] }
//     POST /claim {env?,key_id,...}   → { lease_id, draft_api_key, api_base_url,
//                                          env, is_prod, expires_at, agent_name, policy }
//     POST /leases/{id}/usage {…}     → { used, remaining, window, should_stop }
//     POST /leases/{id}/release       → { released: true }
//
// The registry root honors $FOUNDRY_HOME (default ~/.foundry), matching the
// daemon. A successful claim is recorded in <root>/active-lease.json so the
// other skills can resolve the credential for the session; `resolve` reads it.
//
// Usage:
//   node foundry-registry.js status
//   node foundry-registry.js keys [--json]
//   node foundry-registry.js claim <key_id> [--env <env>] [--repo <repo>]
//   node foundry-registry.js resolve            # prints KEY<TAB>URL (env wins)
//   node foundry-registry.js usage <json>       # {model,input_tokens,...}
//   node foundry-registry.js release
//
// Exit codes: 0 ok; 3 daemon not running; 4 no active lease; 1 other error.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

function registryRoot() {
  return process.env.FOUNDRY_HOME || path.join(os.homedir(), ".foundry");
}
function daemonInfoPath() {
  return path.join(registryRoot(), "daemon.json");
}
function activeLeasePath() {
  return path.join(registryRoot(), "active-lease.json");
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Resolve the running daemon's address + IPC token, or null if it isn't up.
function daemonInfo() {
  const info = readJSON(daemonInfoPath());
  if (!info || !info.base_url || !info.token) return null;
  return info;
}

// Minimal loopback HTTP call to the daemon. Returns { status, body } where body
// is the parsed JSON (or null). Never throws on non-2xx — the caller branches
// on status.
function daemonRequest(info, method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(info.base_url + apiPath);
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const headers = { Authorization: `Bearer ${info.token}` };
    if (payload != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function fail(msg, code) {
  process.stderr.write(msg + "\n");
  process.exit(code || 1);
}

// Require a running daemon; exit 3 with guidance if it isn't up.
async function requireDaemon() {
  const info = daemonInfo();
  if (!info) {
    fail(
      "The Foundry Agent Registry daemon isn't running.\n" +
        "Start it with `foundry daemon &` (and `foundry login` if you haven't yet),\n" +
        "or set DRAFT_API_KEY directly to skip the registry.",
      3,
    );
  }
  // Confirm liveness — a stale daemon.json can outlive the process.
  try {
    const health = await daemonRequest(info, "GET", "/health");
    if (health.status !== 200 || !health.body || !health.body.ok) {
      fail("The daemon info is stale (health check failed). Restart `foundry daemon`.", 3);
    }
  } catch {
    fail("Couldn't reach the daemon (it may have exited). Restart `foundry daemon`.", 3);
  }
  return info;
}

async function cmdStatus() {
  const info = await requireDaemon();
  const res = await daemonRequest(info, "GET", "/status");
  if (res.status !== 200) fail(`daemon /status returned ${res.status}`, 1);
  process.stdout.write(JSON.stringify(res.body, null, 2) + "\n");
}

async function cmdKeys(json) {
  const info = await requireDaemon();
  const res = await daemonRequest(info, "GET", "/keys");
  if (res.status !== 200) fail(`daemon /keys returned ${res.status}`, 1);
  const keys = (res.body && res.body.keys) || [];
  if (json) {
    process.stdout.write(JSON.stringify(keys, null, 2) + "\n");
    return;
  }
  if (keys.length === 0) {
    process.stdout.write("No leasable keys. Are you logged in? Try `foundry login`.\n");
    return;
  }
  // Group by project (organization) for a readable, pickable listing.
  const byProject = new Map();
  for (const k of keys) {
    const proj = k.project || "(no project)";
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(k);
  }
  let i = 0;
  for (const [proj, group] of byProject) {
    process.stdout.write(`\nProject ${proj}\n`);
    for (const k of group) {
      i += 1;
      const avail = k.availability === "available" ? "available" : "in use";
      const prod = k.is_prod ? " [PROD]" : "";
      const who =
        k.availability !== "available" && k.in_use_by
          ? ` — held by ${k.in_use_by.hostname || "?"}${k.in_use_by.plugin ? " / " + k.in_use_by.plugin : ""}`
          : "";
      process.stdout.write(
        `  ${i}. ${k.agent_name} · ${k.name} (${k.prefix}…)${prod} — ${avail}${who}\n` +
          `      env=${k.env} key_id=${k.key_id}\n`,
      );
    }
  }
  process.stdout.write("\nClaim one with: node foundry-registry.js claim <key_id> [--env <env>]\n");
}

async function cmdClaim(keyId, opts) {
  if (!keyId) fail("claim requires a key_id", 1);
  const info = await requireDaemon();
  const body = { key_id: keyId, plugin: opts.plugin || "" };
  if (opts.env) body.env = opts.env;
  if (opts.repo) body.repo = opts.repo;
  if (opts.sessionId) body.session_id = opts.sessionId;
  const res = await daemonRequest(info, "POST", "/claim", body);
  if (res.status === 409) {
    fail("That key is already in use (claimed by another process). Pick an available one.", 1);
  }
  if (res.status !== 201 && res.status !== 200) {
    const m = (res.body && (res.body.message || res.body.error)) || `status ${res.status}`;
    fail(`Claim failed: ${m}`, 1);
  }
  const c = res.body;
  // Record the active lease so the other skills can resolve the credential for
  // the rest of the session. Includes the daemon coordinates so usage/release
  // reach the same daemon.
  const record = {
    lease_id: c.lease_id,
    draft_api_key: c.draft_api_key,
    api_base_url: c.api_base_url,
    env: c.env,
    is_prod: c.is_prod,
    agent_name: c.agent_name,
    expires_at: c.expires_at,
    policy: c.policy || null,
    daemon: { base_url: info.base_url, token: info.token },
    claimed_at: new Date().toISOString(),
  };
  writePrivate(activeLeasePath(), JSON.stringify(record, null, 2));
  // Print a human summary to stderr and the machine record to stdout so a
  // caller can both show the user and capture the JSON.
  process.stderr.write(
    `Claimed ${c.agent_name || keyId} on ${c.env}${c.is_prod ? " [PROD]" : ""}.\n` +
      `Lease ${c.lease_id} — expires ${c.expires_at}.\n`,
  );
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
}

// resolve: print the effective credential as `KEY\tURL`. An explicit
// DRAFT_API_KEY in the environment always wins (backward compatible); otherwise
// fall back to the claimed active lease. Exit 4 if neither is available.
function cmdResolve() {
  if (process.env.DRAFT_API_KEY) {
    const url = process.env.DRAFT_API_URL || "https://draft.foundryworks.dev";
    process.stdout.write(`${process.env.DRAFT_API_KEY}\t${url}\n`);
    return;
  }
  const lease = readJSON(activeLeasePath());
  if (lease && lease.draft_api_key && lease.api_base_url) {
    process.stdout.write(`${lease.draft_api_key}\t${lease.api_base_url}\n`);
    return;
  }
  fail(
    "No credential: DRAFT_API_KEY isn't set and no key is claimed.\n" +
      "Run the agents command to pick one from the registry.",
    4,
  );
}

async function cmdUsage(jsonArg) {
  const lease = readJSON(activeLeasePath());
  if (!lease || !lease.lease_id) fail("No active lease to report usage against.", 4);
  let usage;
  try {
    usage = JSON.parse(jsonArg);
  } catch {
    fail("usage requires a JSON object argument, e.g. '{\"model\":\"…\",\"input_tokens\":10}'", 1);
  }
  const res = await daemonRequest(
    lease.daemon,
    "POST",
    `/leases/${lease.lease_id}/usage`,
    usage,
  );
  if (res.status !== 200) {
    const m = (res.body && (res.body.message || res.body.error)) || `status ${res.status}`;
    fail(`Usage report failed: ${m}`, 1);
  }
  process.stdout.write(JSON.stringify(res.body, null, 2) + "\n");
  // Surface should_stop as a distinct exit so a loop can honor it.
  if (res.body && res.body.should_stop) process.exit(10);
}

async function cmdRelease() {
  const lease = readJSON(activeLeasePath());
  if (!lease || !lease.lease_id) {
    // Nothing to release — treat as success so exit hooks stay quiet.
    process.stdout.write("No active lease.\n");
    return;
  }
  try {
    await daemonRequest(lease.daemon, "POST", `/leases/${lease.lease_id}/release`);
  } catch {
    // Best effort: the daemon/server idle auto-release reclaims it anyway.
  }
  try {
    fs.unlinkSync(activeLeasePath());
  } catch {
    /* already gone */
  }
  process.stdout.write("Released.\n");
}

function writePrivate(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, { mode: 0o600 });
}

function parseOpts(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--env") opts.env = args[++i];
    else if (a === "--repo") opts.repo = args[++i];
    else if (a === "--plugin") opts.plugin = args[++i];
    else if (a === "--session-id") opts.sessionId = args[++i];
    else positional.push(a);
  }
  return { opts, positional };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, positional } = parseOpts(rest);
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "keys":
      return cmdKeys(opts.json);
    case "claim":
      return cmdClaim(positional[0], opts);
    case "resolve":
      return cmdResolve();
    case "usage":
      return cmdUsage(positional[0]);
    case "release":
      return cmdRelease();
    default:
      fail(
        "Usage: foundry-registry.js <status|keys|claim <key_id>|resolve|usage <json>|release>",
        1,
      );
  }
}

main().catch((e) => fail(String((e && e.message) || e), 1));
