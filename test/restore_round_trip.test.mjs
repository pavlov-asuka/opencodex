/**
 * Leaving OpenCodex and coming back must both work.
 *
 * Restore-Native-Codex.cmd strips the managed block from config.toml. Startup
 * only ever *synchronised* a block that was already there, so running
 * OpenCodex.exe afterwards brought the gateway up with the providers and
 * models intact and no route from Codex to reach them — the dashboard looked
 * healthy and third-party models simply never appeared. The way back was a
 * "重启 Codex" click nobody would think to make.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexBridgeServer } from "../dist/server/gateway.js";
import { createRecordingDesktopController } from "../dist/platform/index.js";

const PORT = 8953;

async function withEnvironment(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-round-"));
  const configPath = path.join(dataDir, "config.toml");
  const saved = {
    data: process.env.OPENCODEX_DATA_DIR,
    config: process.env.OPENCODEX_CODEX_CONFIG_PATH,
  };
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = configPath;
  try {
    return await run(dataDir, configPath);
  } finally {
    if (saved.data === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = saved.data;
    if (saved.config === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = saved.config;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

/** A machine that has configured a third-party provider, as after first setup. */
async function seedConfiguredProvider(dataDir) {
  await fs.writeFile(
    path.join(dataDir, "providers.json"),
    JSON.stringify({ providers: [{ name: "deepseek", baseUrl: "https://api.deepseek.com/", models: ["deepseek-v4-flash"] }] }),
    "utf8",
  );
}

test("starting after a restore re-establishes the Codex route", async () => {
  await withEnvironment(async (dataDir, configPath) => {
    await seedConfiguredProvider(dataDir);

    // Exactly what Restore-Native-Codex.cmd leaves behind: the user's own
    // settings, and no managed block.
    await fs.writeFile(configPath, 'model = "gpt-5.6"\n', "utf8");

    const server = new CodexBridgeServer(PORT, createRecordingDesktopController());
    await server.start();
    try {
      const config = await fs.readFile(configPath, "utf8");
      assert.match(config, /opencodex managed/, "the managed block must be written back on startup");
      assert.match(config, /\[model_providers\.opencodex\]/);
      assert.match(config, new RegExp(`127\\.0\\.0\\.1:${PORT}`), "and point at this gateway");
      assert.match(config, /model = "gpt-5\.6"/, "without disturbing the user's own settings");
    } finally {
      await server.stop();
    }
  });
});

test("a machine with no third-party models is left native", async () => {
  await withEnvironment(async (dataDir, configPath) => {
    // No providers.json at all: a first run, or someone who only uses official
    // models. Writing a managed block here would route official traffic
    // through a gateway that has nothing to add.
    await fs.writeFile(configPath, 'model = "gpt-5.6"\n', "utf8");

    const server = new CodexBridgeServer(PORT, createRecordingDesktopController());
    await server.start();
    try {
      const config = await fs.readFile(configPath, "utf8");
      assert.doesNotMatch(config, /opencodex managed/, "nothing to manage, nothing written");
      assert.match(config, /model = "gpt-5\.6"/);
    } finally {
      await server.stop();
    }
  });
});
