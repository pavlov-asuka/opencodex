import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const gateway = () => readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
const credentials = () => readFile(new URL("../src_v2/services/credential_store.ts", import.meta.url), "utf8");

test("the gateway binds loopback only and gates /api behind the token", async () => {
  // Was four regexes over gateway.ts looking for the listen address, the
  // requireAdmin call and the cookie name. They pin how the code is spelled,
  // not what the running server does, and would keep passing if the handler
  // were wired up but never reached.
  const net = await import("node:net");
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const http = await import("node:http");
  const { CodexBridgeServer } = await import("../dist/server/gateway.js");
  const { createRecordingDesktopController } = await import("../dist/platform/index.js");

  const PORT = 8952;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-sec-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");

  const server = new CodexBridgeServer(PORT, createRecordingDesktopController());
  await server.start();

  const request = (headers) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/api/providers", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });

  const reachable = (host) => new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT });
    const done = (value) => { socket.destroy(); resolve(value); };
    // A gateway bound to 0.0.0.0 answers a local interface immediately; this
    // only has to outlast that, not a real network round trip.
    socket.setTimeout(1200);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

  try {
    assert.equal(await reachable("127.0.0.1"), true, "the dashboard must work locally");

    // Every non-loopback IPv4 this machine owns. A gateway bound to 0.0.0.0
    // would answer on these, exposing the admin API and the ChatGPT-authorized
    // endpoints to the whole network.
    const external = Object.values(os.networkInterfaces()).flat()
      .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const address of external) {
      assert.equal(await reachable(address), false, `the gateway must not answer on ${address}`);
    }

    assert.equal(await request({}), 401, "/api must refuse an unauthenticated caller");
    assert.equal(await request({ Authorization: `Bearer ${server.adminToken}` }), 200, "the real token works");
    assert.equal(
      await request({ Authorization: `Bearer ${"x".repeat(String(server.adminToken).length)}` }),
      401,
      "a same-length wrong token is refused",
    );
    assert.equal(await request({ Cookie: `opencodex_admin=${server.adminToken}` }), 200, "the browser cookie works");
  } finally {
    await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("token comparison is constant-time", async () => {
  // Deliberately a source check. Whether a comparison leaks timing cannot be
  // observed from a black-box request without statistical analysis that would
  // be slow and flaky, so this asserts the mechanism instead of the effect —
  // the one case in this file where reading the source is the right tool.
  assert.match(await gateway(), /timingSafeEqual/);
});

test("provider APIs never return plaintext credentials", async () => {
  const [source, store] = await Promise.all([gateway(), credentials()]);
  assert.match(source, /const \{ api_key: _apiKey/);
  assert.match(source, /api_key_configured/);
  assert.match(store, /OpenCodex Provider Credential/);
  assert.match(store, /delete provider\.api_key/);
});

test("providers.json is written with restrictive permissions", async () => {
  // Was a regex for /posixPermissions|chmodSync/ over credential_store.ts,
  // which broke the moment the write moved into writeJsonAtomic even though
  // the permissions were unchanged. Check the file instead of the spelling.
  const { CredentialStore } = await import("../dist/services/credential_store.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-perm-"));
  const previous = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    CredentialStore.saveProviders([{ name: "deepseek", base_url: "https://api.deepseek.com/v1", models: [] }]);
    const target = path.join(dataDir, "providers.json");
    const stats = await fs.stat(target);

    // Windows does not implement POSIX mode bits, so only the owner-only
    // guarantee is checkable there: no group or world bits on POSIX.
    if (process.platform !== "win32") {
      assert.equal(stats.mode & 0o077, 0, "providers.json must not be readable by group or world");
    }
    const written = JSON.parse(await fs.readFile(target, "utf8"));
    assert.equal(written.providers[0].api_key, undefined, "no credential may reach the file");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("the gateway never builds a shell command string", async () => {
  const source = await gateway();
  assert.doesNotMatch(source, /execSync\(/);
  assert.doesNotMatch(source, /\.exec\(/);
});

test("V2 has no runtime dependency on the retired gateway tree", async () => {
  const source = await gateway();
  const retiredGatewayPattern = new RegExp(["legacy", "proxy", "backup"].join("_"));
  assert.doesNotMatch(source, retiredGatewayPattern);
  assert.equal(source.includes("src/proxy"), false);
  assert.equal(source.includes("dist/proxy"), false);
});

test("model routing is owned by imported catalog metadata and has no provider-order fallback", async () => {
  const source = await gateway();
  assert.match(source, /findCatalogProvider/);
  assert.match(source, /no fallback provider was selected/);
  assert.doesNotMatch(source, /providers\.find\([\s\S]{0,240}providers\[0\]/);
  assert.match(source, /backend_provider/);
});

test("native GPT models pass through the Codex backend when the gateway is enabled", async () => {
  const source = await gateway();
  assert.match(source, /isNativeCatalogModel/);
  assert.match(source, /proxyNativeResponses/);
  assert.match(source, /chatgpt\.com\/backend-api\/codex\/responses/);
});

test("third-party native Responses routing is explicit and can fall back to Chat", async () => {
  const [source, router] = await Promise.all([
    gateway(),
    readFile(new URL("../src_v2/server/router.ts", import.meta.url), "utf8")
  ]);
  assert.match(source, /protocol/);
  assert.match(router, /proxyThirdPartyResponses/);
  assert.match(router, /Responses unsupported by/);
  assert.match(router, /protocol: \"chat\"/);
  assert.match(router, /native-third-party-responses/);
});
