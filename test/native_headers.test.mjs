import test from "node:test";
import assert from "node:assert/strict";
import { copyNativeRequestHeaders, isLocalOrPlaceholderBearer } from "../dist/server/native_headers.js";

function request(url, headers = {}) {
  return { url, headers };
}

test("decoded request bodies do not retain the original content-encoding header", () => {
  const headers = copyNativeRequestHeaders(request("/v1/responses", {
    host: "127.0.0.1:8765",
    authorization: "Bearer gateway-token",
    "content-type": "application/json",
    "content-encoding": "zstd",
  }), { localAdminToken: "gateway-token", nativeAccessToken: "native-token" }, true);

  // The gateway decodes bodies before replaying them; forwarding the original
  // encoding makes the upstream try to decompress plain JSON and answer 400.
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(headers.authorization, "Bearer native-token");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.host, undefined);
});

test("the local gateway bearer is never forwarded upstream", () => {
  const headers = copyNativeRequestHeaders(request("/v1/responses", {
    host: "127.0.0.1:8765",
    authorization: "Bearer gateway-token",
  }), { localAdminToken: "gateway-token" }, false);

  assert.equal(headers.authorization, undefined);
});

test("a real API bearer is preserved for a non-native session", () => {
  const headers = copyNativeRequestHeaders(request("/v1/responses", {
    host: "127.0.0.1:8765",
    authorization: "Bearer sk-test-key",
  }), { localAdminToken: "gateway-token", nativeAccessToken: "native-token" }, false);

  assert.equal(headers.authorization, "Bearer sk-test-key");
});

test("placeholder and local bearers are recognized, real keys are not", () => {
  assert.equal(isLocalOrPlaceholderBearer("Bearer gateway-token", "gateway-token"), true);
  assert.equal(isLocalOrPlaceholderBearer("Bearer dummy", "gateway-token"), true);
  assert.equal(isLocalOrPlaceholderBearer("", "gateway-token"), true);
  assert.equal(isLocalOrPlaceholderBearer("Bearer sk-test-key", "gateway-token"), false);
});
