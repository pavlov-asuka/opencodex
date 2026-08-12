/**
 * Native ChatGPT/Codex request headers.
 *
 * Every request the gateway replays to the native backend — a passthrough GPT
 * turn, the native image tool, the encrypted-agent-message oracle, and the
 * provider bridge — is authorized with the Codex desktop session rather than
 * with the local gateway token the client happens to be carrying.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { codexHomePath } from "../platform/paths.js";

/**
 * Resolved per call. As a module-load constant it ignored CODEX_HOME, so a
 * user with a custom Codex directory had their token read from the wrong tree.
 */
function codexAuthPath(): string {
  return path.join(codexHomePath(), "auth.json");
}

export type NativeProxyOptions = {
  /** The bearer token installed in Codex config for the local gateway. */
  localAdminToken?: string;
  /** Test-only override; production reads the native Codex access token. */
  nativeAccessToken?: string;
};

function headerValue(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

export function readNativeAccessToken(): string {
  try {
    const auth = JSON.parse(fs.readFileSync(codexAuthPath(), "utf-8"));
    return typeof auth?.tokens?.access_token === "string" ? auth.tokens.access_token.trim() : "";
  } catch {
    return "";
  }
}

function bearerValue(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

export function isLocalOrPlaceholderBearer(value: string, localAdminToken?: string): boolean {
  const token = bearerValue(value);
  if (!token) return true;
  if (localAdminToken && token === localAdminToken) return true;
  return /dummy|opencodex/i.test(token);
}

export function copyNativeRequestHeaders(req: http.IncomingMessage, options: NativeProxyOptions = {}, nativeSession = true): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "upgrade") continue;
    // The gateway decodes request bodies before replaying them upstream. Do
    // not forward the original content-encoding or the upstream will try to
    // decompress an already-decoded JSON body and answer with a generic 400.
    if (lowerKey === "content-length" || lowerKey === "transfer-encoding" || lowerKey === "content-encoding") continue;
    if (lowerKey.startsWith("sec-websocket-")) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value === "string") headers[key] = value;
  }

  const incomingAuthorization = headerValue(req, "authorization");
  const nativeToken = options.nativeAccessToken || readNativeAccessToken();
  if (nativeSession && nativeToken && isLocalOrPlaceholderBearer(incomingAuthorization, options.localAdminToken)) {
    headers.authorization = `Bearer ${nativeToken}`;
  } else if (isLocalOrPlaceholderBearer(incomingAuthorization, options.localAdminToken)) {
    delete headers.authorization;
  }
  return headers;
}
