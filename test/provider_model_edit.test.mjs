/**
 * Editing a provider's model list must actually remove what was removed.
 *
 * The catalog filter was inverted. For an entry the provider owned it returned
 * `!desiredSlugs.has(...)`, so it deleted the models still selected and kept
 * the ones the user had just dropped; the upsert loop then re-added the
 * selected models alongside. Removed models therefore survived every edit,
 * stayed in the Codex model menu, and failed when chosen.
 *
 * No test had ever edited a provider's model list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rebuildProviderCatalogModels } from "../dist/server/gateway.js";

/** Catalog slugs are namespaced by owner, which is the identity Codex routes on. */
const slugsFor = (catalog, owner) =>
  catalog.models
    .filter((model) => (model.backend_provider || model.provider_name) === owner)
    .map((model) => model.slug)
    .sort();

test("changing A,B to B,C leaves exactly B,C", () => {
  const catalog = { models: [] };

  rebuildProviderCatalogModels(catalog, "deepseek", ["model-a", "model-b"]);
  assert.deepEqual(slugsFor(catalog, "deepseek"), ["deepseek/model-a", "deepseek/model-b"]);

  rebuildProviderCatalogModels(catalog, "deepseek", ["model-b", "model-c"]);
  assert.deepEqual(
    slugsFor(catalog, "deepseek"),
    ["deepseek/model-b", "deepseek/model-c"],
    "model-a must be gone",
  );
});

test("removing every model empties the provider", () => {
  const catalog = { models: [] };
  rebuildProviderCatalogModels(catalog, "deepseek", ["model-a", "model-b"]);
  rebuildProviderCatalogModels(catalog, "deepseek", []);
  assert.deepEqual(slugsFor(catalog, "deepseek"), []);
});

test("another provider's models are untouched", () => {
  const catalog = { models: [] };
  rebuildProviderCatalogModels(catalog, "deepseek", ["ds-1", "ds-2"]);
  rebuildProviderCatalogModels(catalog, "moonshot", ["ms-1"]);

  rebuildProviderCatalogModels(catalog, "deepseek", ["ds-2"]);

  assert.deepEqual(slugsFor(catalog, "deepseek"), ["deepseek/ds-2"]);
  assert.deepEqual(slugsFor(catalog, "moonshot"), ["moonshot/ms-1"], "editing one provider must not disturb another");
});

test("re-submitting the same list is stable", () => {
  const catalog = { models: [] };
  rebuildProviderCatalogModels(catalog, "deepseek", ["model-a", "model-b"]);
  const first = JSON.stringify(catalog);
  rebuildProviderCatalogModels(catalog, "deepseek", ["model-a", "model-b"]);
  assert.equal(JSON.stringify(catalog), first, "an unchanged edit must not duplicate or reorder entries");
});

test("a backend mapping keeps the slug as the catalog identity", () => {
  const catalog = { models: [] };
  rebuildProviderCatalogModels(catalog, "deepseek", ["deepseek-v4-flash=deepseek-chat"]);

  const entry = catalog.models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
  assert.ok(entry, "the slug is what Codex shows and routes on");
  assert.equal(entry.backend_model, "deepseek-chat");

  // And the mapped form is replaced, not duplicated, when it changes.
  rebuildProviderCatalogModels(catalog, "deepseek", ["deepseek-v4-flash=deepseek-reasoner"]);
  assert.equal(slugsFor(catalog, "deepseek").length, 1);
  assert.equal(
    catalog.models.find((model) => model.slug === "deepseek/deepseek-v4-flash").backend_model,
    "deepseek-reasoner",
  );
});

test("blank entries are ignored rather than creating empty models", () => {
  const catalog = { models: [] };
  rebuildProviderCatalogModels(catalog, "deepseek", ["", "  ", "model-a"]);
  assert.deepEqual(slugsFor(catalog, "deepseek"), ["deepseek/model-a"]);
});
