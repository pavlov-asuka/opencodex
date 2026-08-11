/**
 * Test entry point.
 *
 * Exists to set OPENCODEX_TEST_MODE before the runner starts, without adding a
 * cross-env dependency for the one variable that matters. With it set, the
 * platform layer hands out a no-op DesktopController, so a test that builds a
 * real CodexBridgeServer cannot reach HKCU\Environment, taskkill, or the real
 * Codex install.
 *
 * Before this existed, `npm test` published CODEX_CLI_PATH into the
 * developer's own environment on start and deleted all six bridge variables on
 * stop — a green run was indistinguishable from a damaged machine.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ["--test", ...(args.length > 0 ? args : ["test/*.test.mjs"])],
  {
    stdio: "inherit",
    env: { ...process.env, OPENCODEX_TEST_MODE: "1" },
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
