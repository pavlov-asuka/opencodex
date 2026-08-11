/**
 * The bridge must find the gateway, not assume where it is.
 *
 * OPENCODEX_GATEWAY_PORT is inherited from whenever Codex Desktop launched.
 * When the gateway later steps aside from an occupied default port, that value
 * points at a stranger, and every routed turn fails with
 * 502 upstream_unreachable — reported against the bridge's own local URL, so
 * the cause is invisible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../src_v2/codex-provider-bridge.ts", import.meta.url), "utf8");

function gatewayLike(port) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: "CodexBridge Engine V2", version: "2.0.1", opencodex: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const close = (server) => new Promise((resolve) => server.close(resolve));

/** Does this port answer as the gateway? */
async function answersAsGateway(port) {
  try {
    const body = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.text());
    return body.includes("CodexBridge Engine V2");
  } catch {
    return false;
  }
}

test("an inherited port that is really the gateway is used as-is", async () => {
  const { resolveGatewayPort } = await import("../dist/codex-provider-bridge.js");
  const previous = process.env.OPENCODEX_GATEWAY_PORT;
  const real = await gatewayLike(8942);
  process.env.OPENCODEX_GATEWAY_PORT = "8942";
  try {
    assert.equal(await resolveGatewayPort(), 8942, "must not wander off a port that is answering");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_GATEWAY_PORT;
    else process.env.OPENCODEX_GATEWAY_PORT = previous;
    await close(real);
  }
});

test("a dead inherited port is not returned when a gateway exists elsewhere", async () => {
  const { resolveGatewayPort } = await import("../dist/codex-provider-bridge.js");
  const previous = process.env.OPENCODEX_GATEWAY_PORT;
  // Nothing listens here. This is the state a bridge inherits after the
  // gateway has moved: the number is stale, so it must not be trusted.
  process.env.OPENCODEX_GATEWAY_PORT = "8943";
  const real = await gatewayLike(8944);
  try {
    const resolved = await resolveGatewayPort();
    assert.notEqual(resolved, 8943, "a port nothing answers on must not be chosen");
    assert.ok(await answersAsGateway(resolved), `resolved port ${resolved} must answer as the gateway`);
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_GATEWAY_PORT;
    else process.env.OPENCODEX_GATEWAY_PORT = previous;
    await close(real);
  }
});

test("a failed upstream is named in the error the client receives", async () => {
  const text = await source();
  // The client used to see only http://127.0.0.1:<egress>/... which says
  // nothing about which upstream was unreachable.
  assert.match(text, /upstream,/);
  assert.match(text, /\(upstream \$\{upstream\}\)/);
  // And the two cases must be told apart in plain words.
  assert.match(text, /The OpenCodex gateway did not answer/);
  assert.match(text, /ChatGPT was not reachable/);
});

test("the egress log records the resolved target, not just the route", async () => {
  const text = await source();
  assert.match(text, /Native Egress\] \$\{route\} \$\{endpoint\} -> /);
});
