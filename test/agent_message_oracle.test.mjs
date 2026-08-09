import test from "node:test";
import assert from "node:assert/strict";

import {
  agentMessageOracleEnabled,
  agentMessageOracleConfig,
  assignmentFromOracleStream,
  envelopeFromAgentMessage,
  hasEncryptedAgentMessage,
  isEncryptedAgentMessage,
} from "../dist/services/agent_message_oracle.js";

// The exact shape Codex sends for a routed child's task. The plaintext ends at
// "Payload:" and the real assignment is a Fernet token the backend minted.
const capturedAgentMessage = {
  type: "agent_message",
  id: "amsg_019fe234-9e59-7b53-986f-c8f0565d527a",
  author: "/root",
  recipient: "/root/deepseek_payload_9137",
  content: [
    { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/deepseek_payload_9137\nSender: /root\nPayload:\n" },
    { type: "encrypted_content", encrypted_content: "gAAAAABqd1k5gbIp1CDJgUns1MsT8iVZ6ha9C74y" },
  ],
};

test("the oracle stays off unless explicitly enabled", () => {
  const previous = process.env.OPENCODEX_AGENT_MESSAGE_ORACLE;
  try {
    delete process.env.OPENCODEX_AGENT_MESSAGE_ORACLE;
    assert.equal(agentMessageOracleEnabled(), false, "must be opt-in: it costs a billed request per task");

    for (const value of ["1", "true", "on", "yes", "YES"]) {
      process.env.OPENCODEX_AGENT_MESSAGE_ORACLE = value;
      assert.equal(agentMessageOracleEnabled(), true, `${value} should enable it`);
    }
    for (const value of ["0", "false", "off", ""]) {
      process.env.OPENCODEX_AGENT_MESSAGE_ORACLE = value;
      assert.equal(agentMessageOracleEnabled(), false, `${value} should leave it off`);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_AGENT_MESSAGE_ORACLE;
    else process.env.OPENCODEX_AGENT_MESSAGE_ORACLE = previous;
  }
});

test("an encrypted child task is recognised and unpacked", () => {
  assert.equal(isEncryptedAgentMessage(capturedAgentMessage), true);
  assert.equal(hasEncryptedAgentMessage({ input: [{ type: "message", role: "user" }, capturedAgentMessage] }), true);

  const envelope = envelopeFromAgentMessage(capturedAgentMessage);
  assert.equal(envelope.author, "/root");
  assert.equal(envelope.recipient, "/root/deepseek_payload_9137");
  assert.equal(envelope.ciphertext, "gAAAAABqd1k5gbIp1CDJgUns1MsT8iVZ6ha9C74y");
  assert.match(envelope.headerText, /Message Type: NEW_TASK/);
});

test("ordinary items are left alone", () => {
  assert.equal(isEncryptedAgentMessage({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }), false);
  // An agent_message whose payload is already plaintext needs no recovery.
  assert.equal(isEncryptedAgentMessage({ type: "agent_message", content: [{ type: "input_text", text: "do the thing" }] }), false);
  assert.equal(hasEncryptedAgentMessage({ input: [] }), false);
  assert.equal(hasEncryptedAgentMessage({}), false);
});

test("the assignment is read out of the forced tool call", () => {
  const stream = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    "",
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"capture_assignment","arguments":"{\\"assignment\\":\\"Scan the repo and report every TODO.\\"}"}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.equal(assignmentFromOracleStream(stream), "Scan the repo and report every TODO.");
});

test("the assignment is also read from a completed response", () => {
  const stream = [
    'data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"capture_assignment","arguments":"{\\"assignment\\":\\"Check module X.\\"}"}]}}',
    "",
  ].join("\n");
  assert.equal(assignmentFromOracleStream(stream), "Check module X.");
});

test("a stream without the forced call yields nothing", () => {
  // Returning "" is what makes the caller fail the turn instead of starting a
  // child with an empty task.
  assert.equal(assignmentFromOracleStream('data: {"type":"response.completed","response":{"output":[]}}\n'), "");
  assert.equal(assignmentFromOracleStream("data: [DONE]\n"), "");
  assert.equal(assignmentFromOracleStream("not an sse stream"), "");
  assert.equal(
    assignmentFromOracleStream('data: {"type":"response.output_item.done","item":{"type":"function_call","name":"other_tool","arguments":"{}"}}\n'),
    "",
  );
});

test("the oracle model and timeout are configurable", () => {
  const previousModel = process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL;
  const previousTimeout = process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS;
  try {
    delete process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL;
    delete process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS;
    assert.deepEqual(agentMessageOracleConfig(), { model: "gpt-5.6-sol", timeoutMs: 60_000 });

    process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL = "gpt-5.6-terra";
    process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS = "9000";
    assert.deepEqual(agentMessageOracleConfig(), { model: "gpt-5.6-terra", timeoutMs: 9000 });

    process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS = "not-a-number";
    assert.equal(agentMessageOracleConfig().timeoutMs, 60_000);
  } finally {
    if (previousModel === undefined) delete process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL;
    else process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL = previousModel;
    if (previousTimeout === undefined) delete process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS;
    else process.env.OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS = previousTimeout;
  }
});
