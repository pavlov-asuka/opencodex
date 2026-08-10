/**
 * Recover the plaintext task for a routed (third-party) Codex subagent.
 *
 * Codex multi-agent v2 delivers a child's task as an `agent_message` whose
 * payload sits in an `encrypted_content` part — a Fernet token minted by, and
 * readable only by, the ChatGPT backend. A routed child therefore receives an
 * envelope whose plaintext ends at "Payload:" and answers that it was given no
 * task. See lidge-jun/opencodex#92 and openai/codex#32031; the proxy holds no
 * key, so nothing local can decrypt it.
 *
 * The workaround (technique published by @Joseffb on lidge-jun/opencodex#92)
 * treats the backend as an oracle for the user's *own* ciphertext: the envelope
 * is replayed to ChatGPT over the user's existing Codex credentials with a
 * forced function call, so the backend decrypts it before model invocation and
 * returns the assignment as ordinary function-call arguments. No key material
 * is extracted and the original ciphertext is preserved byte-for-byte outside
 * that one isolated request.
 *
 * It costs one extra ChatGPT Responses call per distinct encrypted message and
 * depends on an undocumented internal format, so it is disabled unless
 * OPENCODEX_AGENT_MESSAGE_ORACLE is set. With it off, the caller is expected to
 * fail the turn loudly rather than hand a child a task it cannot read.
 */

import { createHash } from "node:crypto";
import { fetchUpstream } from "./upstream_fetch.js";
import { readNativeAccessToken } from "../server/native_headers.js";

const ORACLE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const ORACLE_TOOL = "capture_assignment";
const ORACLE_PROMPT =
  "You are a transport normalization probe. Read the received agent message. " +
  `Call ${ORACLE_TOOL} exactly once with the complete plaintext task payload intended for ` +
  "the child. Preserve it exactly; do not summarize, execute, explain, or add text.";

const MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;

/** One encrypted task envelope lifted out of a request's `input`. */
export type AgentMessageEnvelope = {
  author: string;
  recipient: string;
  headerText: string;
  ciphertext: string;
};

export type OracleConfig = {
  model: string;
  timeoutMs: number;
};

// Keyed by ciphertext digest: a retried turn replays the same envelope, and the
// point of the cache is to keep that to a single billed request.
const assignmentCache = new Map<string, string>();

export function agentMessageOracleEnabled(): boolean {
  const raw = String(process.env.OPENCODEX_AGENT_MESSAGE_ORACLE || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function agentMessageOracleConfig(): OracleConfig {
  const model = String(process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL || "").trim() || "gpt-5.6-sol";
  const timeout = Number.parseInt(String(process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS || ""), 10);
  return { model, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000 };
}

function contentParts(item: any): any[] {
  return Array.isArray(item?.content) ? item.content : [];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** True when this item is an agent_message carrying an unreadable payload. */
export function isEncryptedAgentMessage(item: any): boolean {
  if (item?.type !== "agent_message") return false;
  return contentParts(item).some((part) => part?.type === "encrypted_content" && cleanText(part.encrypted_content).length > 0);
}

export function envelopeFromAgentMessage(item: any): AgentMessageEnvelope | null {
  if (!isEncryptedAgentMessage(item)) return null;
  const parts = contentParts(item);
  const ciphertext = cleanText(parts.find((part) => part?.type === "encrypted_content")?.encrypted_content).trim();
  if (!ciphertext) return null;
  const headerText = parts
    .filter((part) => part?.type === "input_text" || part?.type === "output_text")
    .map((part) => cleanText(part.text))
    .join("\n");
  return {
    author: cleanText(item.author) || "/root",
    recipient: cleanText(item.recipient) || "/root/worker",
    headerText,
    ciphertext,
  };
}

function cacheKey(ciphertext: string): string {
  return createHash("sha256").update(ciphertext).digest("hex");
}

function oraclePayload(envelope: AgentMessageEnvelope, model: string): any {
  return {
    model,
    stream: true,
    store: false,
    instructions: ORACLE_PROMPT,
    tools: [
      {
        type: "function",
        name: ORACLE_TOOL,
        description: "Capture the exact decrypted child task payload.",
        parameters: {
          type: "object",
          properties: { assignment: { type: "string" } },
          required: ["assignment"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    // Forcing the call is what makes the backend surface the decrypted text as
    // arguments instead of acting on the task.
    tool_choice: { type: "function", name: ORACLE_TOOL },
    input: [
      {
        type: "agent_message",
        author: envelope.author,
        recipient: envelope.recipient,
        content: [
          { type: "input_text", text: envelope.headerText },
          { type: "encrypted_content", encrypted_content: envelope.ciphertext },
        ],
      },
    ],
  };
}

/** Pull the forced call's `assignment` argument out of the SSE stream. */
export function assignmentFromOracleStream(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    let event: any;
    try { event = JSON.parse(data); } catch { continue; }

    const candidates: any[] = [];
    if (event?.type === "response.output_item.done") candidates.push(event.item);
    if (event?.type === "response.completed" && Array.isArray(event.response?.output)) {
      candidates.push(...event.response.output);
    }
    for (const item of candidates) {
      if (item?.type !== "function_call" || item?.name !== ORACLE_TOOL) continue;
      if (typeof item.arguments !== "string") continue;
      try {
        const args = JSON.parse(item.arguments);
        const assignment = cleanText(args?.assignment);
        if (assignment && Buffer.byteLength(assignment, "utf-8") <= MAX_ASSIGNMENT_BYTES) return assignment;
      } catch {}
    }
  }
  return "";
}

/**
 * Ask the backend to decrypt one envelope. Returns "" when the oracle is
 * unavailable or produced nothing usable; callers must treat that as a failure
 * rather than forwarding the unreadable envelope.
 */
export async function resolveAgentMessageAssignment(
  envelope: AgentMessageEnvelope,
  accountId = "",
): Promise<string> {
  const key = cacheKey(envelope.ciphertext);
  const cached = assignmentCache.get(key);
  if (cached !== undefined) return cached;

  const token = readNativeAccessToken();
  if (!token) {
    console.warn("[OpenCodex Subagent] Agent message oracle needs the native Codex credentials; none were found.");
    return "";
  }

  const config = agentMessageOracleConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: "codex_cli_rs",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  try {
    const response = await fetchUpstream(ORACLE_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(oraclePayload(envelope, config.model)),
      timeoutMs: config.timeoutMs,
      operation: "agent message oracle",
    } as any);
    if (!response.ok) {
      console.warn(`[OpenCodex Subagent] Agent message oracle returned ${response.status}.`);
      return "";
    }
    const assignment = assignmentFromOracleStream(await response.text());
    if (!assignment) {
      console.warn("[OpenCodex Subagent] Agent message oracle returned no assignment.");
      return "";
    }
    if (assignmentCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = assignmentCache.keys().next().value;
      if (oldest) assignmentCache.delete(oldest);
    }
    assignmentCache.set(key, assignment);
    return assignment;
  } catch (error: any) {
    console.warn(`[OpenCodex Subagent] Agent message oracle failed: ${error?.message || error}`);
    return "";
  }
}

export type OracleOutcome = {
  /** Encrypted agent messages seen in this request. */
  encrypted: number;
  /** How many were replaced with readable text. */
  resolved: number;
};

/**
 * Convert an agent_message into ordinary Responses input.
 *
 * `agent_message` is an OpenAI-internal item type carrying `author`/`recipient`
 * fields. A third-party Responses implementation does not model it and simply
 * ignores the item, so a child would still see no task even after the payload
 * is recovered. Re-express it as a normal user message and fold the routing
 * fields into the text so the framing survives.
 */
export function agentMessageAsProviderInput(item: any, text: string): any {
  const author = cleanText(item?.author);
  const recipient = cleanText(item?.recipient);
  const routing = author || recipient
    ? `[agent message${author ? ` from ${author}` : ""}${recipient ? ` to ${recipient}` : ""}]\n`
    : "";
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `${routing}${text}` }],
  };
}

/**
 * Make every agent_message in `body.input` readable by a third-party provider.
 *
 * Mutates `body` in place. Encrypted payloads are recovered through the oracle
 * and the envelope's own header is kept so the child still sees its NEW_TASK
 * framing; every agent_message — recovered or already plaintext — is then
 * re-expressed as standard provider input.
 */
export async function resolveEncryptedAgentMessages(body: any, accountId = ""): Promise<OracleOutcome> {
  const input = Array.isArray(body?.input) ? body.input : [];
  const outcome: OracleOutcome = { encrypted: 0, resolved: 0 };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item?.type !== "agent_message") continue;

    const envelope = envelopeFromAgentMessage(item);
    if (!envelope) {
      // Already plaintext: it still needs the item-type conversion.
      const text = contentParts(item)
        .filter((part) => part?.type === "input_text" || part?.type === "output_text")
        .map((part) => cleanText(part.text))
        .join("\n");
      if (text) input[index] = agentMessageAsProviderInput(item, text);
      continue;
    }

    outcome.encrypted += 1;
    const assignment = await resolveAgentMessageAssignment(envelope, accountId);
    if (!assignment) continue;

    input[index] = agentMessageAsProviderInput(item, `${envelope.headerText}${assignment}`);
    outcome.resolved += 1;
  }
  return outcome;
}

/** True when any input item carries an unreadable encrypted task payload. */
export function hasEncryptedAgentMessage(body: any): boolean {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some(isEncryptedAgentMessage);
}
