/**
 * Invariants for the slim-down refactor.
 *
 * These assertions describe the one capability this repository exists for:
 * a third-party model reaching Codex Desktop as if it were native. Every
 * deletion phase in docs/SLIM_PLAN.md must leave them passing.
 *
 * They deliberately cover the paths the existing suite exercises only
 * indirectly — most importantly GatewayRouter.handleResponses, which carries
 * every provider turn and is also where the Cursor protocol is interleaved.
 *
 * DO NOT DELETE THESE WITH A FEATURE. If one starts failing, the deletion
 * went too far; fix the deletion, not the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { GatewayRouter } from "../dist/server/router.js";
import { CodexBridgeServer } from "../dist/server/gateway.js";

/** Minimal SSE stream in the shape a Responses-capable provider returns. */
const PROVIDER_STREAM = [
  `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_provider_1", model: "deepseek-v4-flash" } })}\n\n`,
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "checking the file" })}\n\n`,
  `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell_command", arguments: '{"command":"dir"}' },
  })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp_provider_1", status: "completed", model: "deepseek-v4-flash" },
  })}\n\n`,
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Start a fake provider plus a gateway-side server whose handler runs the real
 * GatewayRouter. Using two real HTTP servers keeps the test honest: nothing
 * about the streaming path is mocked away.
 */
async function withRouter(run, { providerHandler } = {}) {
  const requests = [];
  const provider = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined, headers: req.headers });
      if (providerHandler) return providerHandler(req, res, raw);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of PROVIDER_STREAM) res.write(chunk);
      res.end();
    });
  });
  const providerPort = await listen(provider);

  const router = new GatewayRouter();
  let failure;
  const gateway = http.createServer(async (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw);
        await router.handleResponses(
          body,
          "deepseek-v4-flash",
          "test-key",
          `http://127.0.0.1:${providerPort}/v1`,
          res,
          "deepseek",
          {},
          "deepseek/deepseek-v4-flash",
          false,
        );
      } catch (error) {
        failure = error;
      }
      if (!res.writableEnded) res.end();
    });
  });
  const gatewayPort = await listen(gateway);

  try {
    await run({ gatewayPort, requests, get failure() { return failure; } });
  } finally {
    await close(gateway);
    await close(provider);
  }
}

function postForStream(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers: { "Content-Type": "application/json" } },
      (response) => {
        let text = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("slim invariant: a Responses provider turn streams through to the client", async () => {
  await withRouter(async ({ gatewayPort, requests, failure }) => {
    const { status, text } = await postForStream(gatewayPort, {
      model: "deepseek/deepseek-v4-flash",
      protocol: "responses",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list the folder" }] }],
    });

    assert.equal(failure, undefined);
    assert.equal(status, 200);
    // The provider is addressed with its own backend model name...
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, "deepseek-v4-flash");
    // ...while the client keeps seeing the catalog slug it selected.
    assert.match(text, /deepseek\/deepseek-v4-flash/);
    // Text and the tool call both survive the relay, and the stream terminates.
    assert.match(text, /checking the file/);
    assert.match(text, /shell_command/);
    assert.match(text, /response\.completed/);
  });
});

test("slim invariant: a provider tool call keeps its call_id for the continuation", async () => {
  await withRouter(async ({ gatewayPort }) => {
    const { text } = await postForStream(gatewayPort, {
      model: "deepseek/deepseek-v4-flash",
      protocol: "responses",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list the folder" }] }],
    });
    // Codex answers a tool call by posting function_call_output with this id.
    // Losing it breaks every multi-step third-party turn.
    assert.match(text, /call_1/);
  });
});

test("slim invariant: a provider error reaches the client instead of hanging", async () => {
  await withRouter(
    async ({ gatewayPort }) => {
      const { status, text } = await postForStream(gatewayPort, {
        model: "deepseek/deepseek-v4-flash",
        protocol: "responses",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      });
      assert.notEqual(status, undefined);
      assert.match(text, /model_unavailable|error/i);
    },
    {
      providerHandler: (_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model_unavailable", type: "invalid_request_error" } }));
      },
    },
  );
});

async function subagentFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-slim-invariant-"));
  await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({
    models: [{
      slug: "deepseek/deepseek-v4-flash",
      backend_model: "deepseek-v4-flash",
      backend_provider: "deepseek",
      reasoning: true,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }],
      default_reasoning_level: "max",
      min_reasoning_level: "max",
    }],
  }));
  return dataDir;
}

test("slim invariant: an explicitly named third-party child routes with no profiles configured", async () => {
  const dataDir = await subagentFixture();
  const previous = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const server = new CodexBridgeServer(0);
    // The real installation this repository serves has no agent_profiles.json
    // at all, so routing mode is "off" and the decision engine never runs.
    // The child must still resolve through the explicit-model branch — that
    // branch is what makes a third-party subagent work, and it lives in the
    // same function as the profile matching that gets deleted.
    const route = server.chooseSubagentRoute(
      {
        model: "deepseek/deepseek-v4-flash",
        client_metadata: { "x-openai-subagent": true, thread_id: "child-thread-1" },
      },
      { headers: { "x-openai-subagent": "1", "thread-id": "child-thread-1" } },
    );

    assert.notEqual(route, null, "a named third-party child must resolve without any Profile");
    assert.equal(route.model, "deepseek/deepseek-v4-flash");
    assert.equal(route.reasoning_effort, "max");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
