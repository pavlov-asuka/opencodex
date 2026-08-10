import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { TaskRouter, readRoutingCatalog } from "../dist/services/task_router.js";
import { SubagentOrchestrator } from "../dist/services/subagent_orchestrator.js";
import { CodexBridgeServer } from "../dist/server/gateway.js";
import { applyDefaultReasoningCapabilities } from "../dist/services/catalog_sync.js";

test("1.1.0 preserves provider-reported reasoning levels beside a broad false flag", () => {
  const model = applyDefaultReasoningCapabilities({
    reasoning: false,
    supported_reasoning_levels: [
      { effort: "low", description: "fast" },
      { effort: "xhigh", description: "deep" },
    ],
    default_reasoning_level: "xhigh",
  });
  assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), ["low", "xhigh"]);
  assert.equal(model.default_reasoning_level, "xhigh");
});

test("1.1.0 merges imported extra reasoning levels when the Desktop cache is stale", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-catalog-merge-"));
  const nativeDir = path.join(root, "codex");
  const dataDir = path.join(root, "opencodex");
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.writeFile(path.join(nativeDir, "models_cache.json"), JSON.stringify({ models: [{
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    }] }));
    await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({ models: [{
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }],
      default_reasoning_level: "max",
    }] }));

    const model = readRoutingCatalog(dataDir, nativeDir).find((entry) => entry.slug === "deepseek/deepseek-v4-pro");
    assert.deepEqual(model?.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "max"]);
    assert.equal(model?.default_reasoning_level, "max");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("1.1.0 preserves per-model context metadata in the routing catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-catalog-context-"));
  try {
    await fs.writeFile(path.join(root, "custom_model_catalog.json"), JSON.stringify({ models: [
      {
        slug: "gpt-5.6-luna",
        backend_model: "gpt-5.6-luna",
        backend_provider: "openai",
        context_window: 272000,
        max_context_window: 1000000,
        context_window_source: "provider_metadata",
      },
      {
        slug: "antigravity/gemini-3.6-flash-medium",
        backend_model: "gemini-3.6-flash-medium",
        backend_provider: "antigravity",
        context_window: 200000,
        max_context_window: 200000,
        context_window_source: "provider_metadata",
      },
    ] }));

    const models = readRoutingCatalog(root, path.join(root, "missing-native"));
    const native = models.find((model) => model.slug === "gpt-5.6-luna");
    const thirdParty = models.find((model) => model.slug === "antigravity/gemini-3.6-flash-medium");
    assert.equal(native?.context_window, 272000);
    assert.equal(native?.max_context_window, 1000000);
    assert.equal(thirdParty?.context_window, 200000);
    assert.equal(thirdParty?.max_context_window, 200000);
    assert.equal(thirdParty?.context_window_source, "provider_metadata");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-agent-routing-"));
  await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({ models: [
    {
      slug: "antigravity/code-model",
      backend_model: "gemini-code-1",
      backend_provider: "antigravity",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
    },
    {
      slug: "thirdparty/review-model",
      backend_model: "review-1",
      backend_provider: "thirdparty",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
      default_reasoning_level: "medium",
    },
    {
      slug: "minimax/minimax-m3",
      backend_model: "minimax-m3",
      backend_provider: "minimax",
      reasoning: true,
      supported_reasoning_levels: [],
    },
    {
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      reasoning: true,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "max" },
      ],
    },
    {
      slug: "opencode/deepseek-v4-flash",
      backend_model: "deepseek-v4-flash",
      backend_provider: "opencode",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "max" },
      ],
    },
  ] }));
  return dataDir;
}

test("1.1.0 preserves provider-reported reasoning levels beside a broad false flag", () => {
  const model = applyDefaultReasoningCapabilities({
    reasoning: false,
    supported_reasoning_levels: [
      { effort: "low", description: "fast" },
      { effort: "xhigh", description: "deep" },
    ],
    default_reasoning_level: "xhigh",
  });
  assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), ["low", "xhigh"]);
  assert.equal(model.default_reasoning_level, "xhigh");
});

test("1.1.0 merges imported extra reasoning levels when the Desktop cache is stale", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-catalog-merge-"));
  const nativeDir = path.join(root, "codex");
  const dataDir = path.join(root, "opencodex");
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.writeFile(path.join(nativeDir, "models_cache.json"), JSON.stringify({ models: [{
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    }] }));
    await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({ models: [{
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }],
      default_reasoning_level: "max",
    }] }));

    const model = readRoutingCatalog(dataDir, nativeDir).find((entry) => entry.slug === "deepseek/deepseek-v4-pro");
    assert.deepEqual(model?.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "max"]);
    assert.equal(model?.default_reasoning_level, "max");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("1.1.0 preserves per-model context metadata in the routing catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-catalog-context-"));
  try {
    await fs.writeFile(path.join(root, "custom_model_catalog.json"), JSON.stringify({ models: [
      {
        slug: "gpt-5.6-luna",
        backend_model: "gpt-5.6-luna",
        backend_provider: "openai",
        context_window: 272000,
        max_context_window: 1000000,
        context_window_source: "provider_metadata",
      },
      {
        slug: "antigravity/gemini-3.6-flash-medium",
        backend_model: "gemini-3.6-flash-medium",
        backend_provider: "antigravity",
        context_window: 200000,
        max_context_window: 200000,
        context_window_source: "provider_metadata",
      },
    ] }));

    const models = readRoutingCatalog(root, path.join(root, "missing-native"));
    const native = models.find((model) => model.slug === "gpt-5.6-luna");
    const thirdParty = models.find((model) => model.slug === "antigravity/gemini-3.6-flash-medium");
    assert.equal(native?.context_window, 272000);
    assert.equal(native?.max_context_window, 1000000);
    assert.equal(thirdParty?.context_window, 200000);
    assert.equal(thirdParty?.max_context_window, 200000);
    assert.equal(thirdParty?.context_window_source, "provider_metadata");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("1.1.0 records native child-task lifecycle without claiming cancellation is execution", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-subagent-lifecycle-"));
  try {
    const orchestrator = new SubagentOrchestrator(dataDir);
    const started = orchestrator.start({
      task_id: "child-1",
      parent_task_id: "parent-1",
      profile_id: "code",
      provider: "antigravity",
      model: "antigravity/code-model",
      backend_model: "gemini-code-1",
      reasoning_effort: "high",
    });
    assert.equal(started.status, "running");
    assert.equal(orchestrator.requestCancel("child-1")?.status, "cancel_requested");
    assert.equal(orchestrator.list(1)[0].parent_task_id, "parent-1");
    assert.equal(orchestrator.complete("child-1")?.status, "completed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- Explicit child model selection -----------------------------------------
// After the routing decision layer was removed, a child turn reaches a model
// exactly one way: the parent names it. These cover that path end to end.

async function withServer(run) {
  const dataDir = await fixture();
  const previous = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    await run(new CodexBridgeServer(0), dataDir);
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function childRequest(model, extra = {}) {
  return {
    model,
    client_metadata: { "x-openai-subagent": "1", session_id: "child-1", parent_task_id: "parent-1", ...extra },
    input: "请完成任务",
  };
}

test("1.2.0 an explicitly named child model resolves against the local catalog", async () => {
  await withServer(async (server) => {
    const route = server.chooseSubagentRoute(childRequest("thirdparty/review-model"));
    assert.equal(route?.model, "thirdparty/review-model");
    assert.equal(server.subagentOrchestrator.list(1)[0].status, "running");
    server.subagentOrchestrator.complete(route.task_id);
    assert.equal(server.subagentOrchestrator.list(1)[0].status, "completed");
  });
});

test("1.2.0 a child keeps its explicitly selected reasoning effort", async () => {
  await withServer(async (server) => {
    const route = server.chooseSubagentRoute({
      ...childRequest("deepseek/deepseek-v4-pro"),
      reasoning: { effort: "max" },
    });
    assert.equal(route?.model, "deepseek/deepseek-v4-pro");
    assert.equal(route?.reasoning_effort, "max");
  });
});

test("1.2.0 a model the catalog does not have is refused, not silently swapped", async () => {
  await withServer(async (server) => {
    assert.equal(server.chooseSubagentRoute(childRequest("nobody/not-imported")), null);
    // Nothing may be recorded for a turn that never started.
    assert.equal(server.subagentOrchestrator.list(10).length, 0);
  });
});

test("1.2.0 concurrent children of one parent are routed by child thread id", async () => {
  await withServer(async (server) => {
    const first = server.chooseSubagentRoute(childRequest("thirdparty/review-model", {
      session_id: "parent-1",
      thread_id: "child-review",
    }));
    const second = server.chooseSubagentRoute(childRequest("deepseek/deepseek-v4-pro", {
      session_id: "parent-1",
      thread_id: "child-deepseek",
    }));

    assert.equal(first?.model, "thirdparty/review-model");
    assert.equal(second?.model, "deepseek/deepseek-v4-pro");
    assert.equal(first?.task_id, "child-review");
    assert.equal(second?.task_id, "child-deepseek");
    assert.equal(server.subagentOrchestrator.list(10).filter((task) => task.parent_task_id === "parent-1").length, 2);
  });
});

test("1.2.0 a prewarm turn is not routed and starts no task", async () => {
  await withServer(async (server) => {
    const headers = {
      "x-openai-subagent": "guardian",
      "x-codex-parent-thread-id": "parent-native",
      "session-id": "child-native",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "child-native",
        parent_thread_id: "parent-native",
        thread_source: "subagent",
        request_kind: "prewarm",
      }),
    };
    assert.equal(server.chooseSubagentRoute({ model: "thirdparty/review-model", input: "预热" }, { headers }), null);
    assert.equal(server.subagentOrchestrator.list(10).length, 0);
  });
});

test("1.2.0 the router exposes no policy engine", () => {
  // Model choice belongs to the client. Reintroducing a resolve()/profiles API
  // here would put the gateway back in the business of overriding it.
  const router = new TaskRouter();
  assert.equal(typeof router.resolveModel, "function");
  assert.equal(typeof router.listModels, "function");
  assert.equal(typeof router.normalizeReasoningEffort, "function");
  for (const removed of ["resolve", "listProfiles", "getSettings", "record"]) {
    assert.equal(router[removed], undefined, `TaskRouter must not expose ${removed}`);
  }
});
