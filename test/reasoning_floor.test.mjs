import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { TaskRouter, applyReasoningFloor, readRoutingCatalog } from "../dist/services/task_router.js";
import { buildFullCatalogEntry } from "../dist/services/catalog_sync.js";

const LEVELS = [
  { effort: "low", description: "fast" },
  { effort: "medium", description: "balanced" },
  { effort: "high", description: "deep" },
  { effort: "max", description: "deepest" },
];

// Slugs are deliberately unique: TaskRouter also reads the real Codex cache,
// and a shared name would make the assertions depend on the test machine.
function catalogFixture() {
  return {
    models: [
      {
        slug: "floortest/pinned",
        backend_model: "floortest-pinned",
        backend_provider: "floortest",
        supported_reasoning_levels: LEVELS,
        default_reasoning_level: "medium",
        min_reasoning_level: "max",
      },
      {
        slug: "floortest/free",
        backend_model: "floortest-free",
        backend_provider: "floortest",
        supported_reasoning_levels: LEVELS,
        default_reasoning_level: "medium",
      },
      {
        slug: "floortest/unsupported-floor",
        backend_model: "floortest-unsupported",
        backend_provider: "floortest",
        supported_reasoning_levels: LEVELS,
        default_reasoning_level: "medium",
        min_reasoning_level: "ultra",
      },
    ],
  };
}

async function withCatalog(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-reasoning-floor-"));
  const dataDir = path.join(root, "opencodex");
  const nativeDir = path.join(root, "codex");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify(catalogFixture()));
  try {
    await run({ dataDir, nativeDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("1.2.0 reads a declared reasoning floor from the catalog", async () => {
  await withCatalog(async ({ dataDir, nativeDir }) => {
    const models = readRoutingCatalog(dataDir, nativeDir);
    const pinned = models.find((model) => model.slug === "floortest/pinned");
    const free = models.find((model) => model.slug === "floortest/free");
    assert.equal(pinned.min_reasoning_level, "max");
    assert.equal(free.min_reasoning_level, undefined);
  });
});

test("1.2.0 ignores a floor the model does not advertise", async () => {
  await withCatalog(async ({ dataDir, nativeDir }) => {
    const models = readRoutingCatalog(dataDir, nativeDir);
    const unsupported = models.find((model) => model.slug === "floortest/unsupported-floor");
    assert.equal(unsupported.min_reasoning_level, undefined);
    assert.equal(applyReasoningFloor(unsupported, "low"), "low");
  });
});

test("1.2.0 raises an effort below the floor and leaves deeper ones alone", async () => {
  await withCatalog(async ({ dataDir, nativeDir }) => {
    const pinned = readRoutingCatalog(dataDir, nativeDir).find((model) => model.slug === "floortest/pinned");
    assert.equal(applyReasoningFloor(pinned, "low"), "max");
    assert.equal(applyReasoningFloor(pinned, "medium"), "max");
    assert.equal(applyReasoningFloor(pinned, "max"), "max");
    // `ultra` outranks `max`; a floor must never pull an effort back down.
    assert.equal(applyReasoningFloor(pinned, "ultra"), "ultra");
    // Nothing requested at all still gets the floor rather than the default.
    assert.equal(applyReasoningFloor(pinned, undefined), "max");
    // An unrecognized name has no defined depth, so it is passed through.
    assert.equal(applyReasoningFloor(pinned, "turbo"), "turbo");
  });
});

test("1.2.0 applies the floor to an explicitly selected per-turn effort", async () => {
  await withCatalog(async ({ dataDir }) => {
    const router = new TaskRouter(dataDir);
    // This is the call the gateway makes on the provider request path, where
    // `preserveExplicit` keeps a picker selection verbatim. A pinned model must
    // still be raised, otherwise the floor is bypassed on every real turn.
    assert.equal(router.normalizeReasoningEffort("floortest/pinned", "low", true), "max");
    assert.equal(router.normalizeReasoningEffort("floortest/pinned", "", true), "max");
    assert.equal(router.normalizeReasoningEffort("floortest/free", "low", true), "low");
    assert.equal(router.normalizeReasoningEffort("floortest/free", "", true), "medium");
  });
});

test("1.2.0 publishes a supported floor into the catalog entry", () => {
  const pinned = buildFullCatalogEntry("deepseek-v4-flash", "deepseek", 128000, "responses", {
    supported_reasoning_levels: LEVELS,
    min_reasoning_level: "max",
  });
  assert.equal(pinned.min_reasoning_level, "max");

  const unsupported = buildFullCatalogEntry("deepseek-v4-flash", "deepseek", 128000, "responses", {
    supported_reasoning_levels: LEVELS,
    min_reasoning_level: "ultra",
  });
  assert.equal(unsupported.min_reasoning_level, undefined);
});
