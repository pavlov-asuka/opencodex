/**
 * Port conflicts.
 *
 * A user reported a blank dashboard: another program held 8765, the launcher
 * treated a successful TCP connect as "the gateway is already running",
 * started nothing, and pointed the browser at the stranger. Identity, not
 * reachability, decides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexBridgeServer } from "../dist/server/gateway.js";

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

/** A port nothing is expected to use, far from the gateway defaults. */
const BASE = 8931;

test("a foreign listener on the default port does not stop the gateway", async () => {
  // Something unrelated owns the port — a static file server, another tool.
  const stranger = http.createServer((_req, res) => { res.writeHead(200); res.end("not us"); });
  await listen(stranger, BASE);
  try {
    const server = new CodexBridgeServer(BASE);
    const port = await server.resolvePort();
    assert.notEqual(port, BASE, "must not try to bind a port held by another program");
    assert.ok(port > BASE && port < BASE + 10, `expected a nearby fallback port, got ${port}`);
  } finally {
    await close(stranger);
  }
});

test("a listener that never answers is still treated as foreign", async () => {
  // A raw TCP listener that accepts and says nothing: the old check would have
  // called this "the gateway", the new one must not.
  const accepted = new Set();
  const silent = net.createServer((socket) => accepted.add(socket));
  await listen(silent, BASE + 1);
  try {
    const server = new CodexBridgeServer(BASE + 1);
    assert.equal(await server.inspectPort(BASE + 1), "foreign");
  } finally {
    // close() waits for open connections, and this server never ends its own
    // side, so drop them explicitly or the test hangs on cleanup.
    for (const socket of accepted) socket.destroy();
    await close(silent);
  }
});

test("our own gateway is recognized and not displaced", async () => {
  const ours = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: "CodexBridge Engine V2", version: "2.0.0", opencodex: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(ours, BASE + 2);
  try {
    const server = new CodexBridgeServer(BASE + 2);
    assert.equal(await server.inspectPort(BASE + 2), "ours");
    // A second instance must refuse rather than move aside and register itself
    // over the healthy one's environment variables.
    await assert.rejects(() => server.resolvePort(), /already running/);
  } finally {
    await close(ours);
  }
});

test("an explicitly configured port is refused, never silently changed", async () => {
  const stranger = http.createServer((_req, res) => { res.writeHead(200); res.end("not us"); });
  await listen(stranger, BASE + 3);
  const previous = process.env.OPENCODEX_PORT;
  process.env.OPENCODEX_PORT = String(BASE + 3);
  try {
    const server = new CodexBridgeServer(BASE + 3);
    await assert.rejects(() => server.resolvePort(), /held by another program/);
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_PORT;
    else process.env.OPENCODEX_PORT = previous;
    await close(stranger);
  }
});

test("a free port is used as-is", async () => {
  const server = new CodexBridgeServer(BASE + 4);
  assert.equal(await server.resolvePort(), BASE + 4);
});

test("the launcher identifies the listener instead of trusting a connect", () => {
  const source = readFileSync(fileURLToPath(new URL("../native/windows-launcher/src/main.rs", import.meta.url)), "utf8");
  // The regression itself: a bare TcpStream::connect must not be what decides
  // whether the gateway is already running.
  assert.match(source, /GET \/health HTTP\/1\.0/);
  assert.match(source, /CodexBridge Engine V2/);
  assert.match(source, /enum Probe/);
  assert.doesNotMatch(source, /fn gateway_is_up/);
  // And a windowless failure has to leave something behind to read.
  assert.match(source, /opencodex-launcher\.log/);
});
