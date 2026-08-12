/**
 * Platform dispatch for the Codex Desktop lifecycle.
 *
 * `server/gateway.ts` calls these free functions exactly as it did when the
 * implementations were inline; only the macOS gate moved from a hard
 * `process.platform !== "darwin"` early return into controller selection, so
 * Windows now gets a real implementation instead of a silent no-op.
 */

import { darwinDesktopController } from "./darwin.js";
import { win32DesktopController } from "./win32.js";
import type { DesktopAppServerState, DesktopController } from "./types.js";

export type { DesktopAppServerState, DesktopController } from "./types.js";
export { codexConfigPath, codexHomePath, openCodexCatalogPath, BRIDGE_ENVIRONMENT_VARIABLES } from "./paths.js";

/**
 * A controller that touches nothing.
 *
 * Serves two callers. Platforms without a Desktop client (Linux, containers,
 * CI) get it because there is nothing to drive — the gateway still runs as a
 * plain HTTP gateway there. Tests get it because the alternative is real
 * damage: a test that constructed a real `CodexBridgeServer` published
 * `CODEX_CLI_PATH` into the developer's own `HKCU\Environment` on start and
 * deleted all six bridge variables on stop, detaching a working Codex Desktop
 * from a healthy gateway.
 */
export const noopDesktopController: DesktopController = {
  platform: process.platform,
  providerBridgePath: () => "",
  nativeCodexExecutablePath: () => "",
  desktopApplicationExecutable: () => "",
  desktopAppServerState: () => "absent",
  stopDesktopClients: () => {},
  launchDesktopClient: () => {},
  registerProviderBridgeEnvironment: () => false,
  unregisterProviderBridgeEnvironment: () => {},
};

/** A no-op controller that remembers what it was asked to do. */
export function createRecordingDesktopController(): DesktopController & { calls: string[] } {
  const calls: string[] = [];
  return {
    ...noopDesktopController,
    calls,
    stopDesktopClients: () => { calls.push("stopDesktopClients"); },
    launchDesktopClient: (cdp: boolean) => { calls.push(`launchDesktopClient:${cdp}`); },
    registerProviderBridgeEnvironment: (port: number) => { calls.push(`register:${port}`); return true; },
    unregisterProviderBridgeEnvironment: () => { calls.push("unregister"); },
  };
}

/** Is this process running the test suite? Set by the `test` npm script. */
export function inTestMode(): boolean {
  return String(process.env.OPENCODEX_TEST_MODE || "").trim() === "1";
}

function selectController(): DesktopController {
  // The backstop for the seam below: `CodexBridgeServer` takes a controller by
  // constructor injection, but a test that forgets to pass one must still not
  // reach the registry, taskkill, or the real Codex install.
  if (inTestMode()) return noopDesktopController;
  switch (process.platform) {
    case "darwin": return darwinDesktopController;
    case "win32": return win32DesktopController;
    default: return noopDesktopController;
  }
}

export const desktopController: DesktopController = selectController();

export function providerBridgePath(): string {
  return desktopController.providerBridgePath();
}

export function nativeCodexExecutablePath(): string {
  return desktopController.nativeCodexExecutablePath();
}

export function desktopApplicationExecutable(): string {
  return desktopController.desktopApplicationExecutable();
}

export function desktopAppServerState(): DesktopAppServerState {
  return desktopController.desktopAppServerState();
}

export function stopDesktopClients(): void {
  desktopController.stopDesktopClients();
}

export function launchDesktopClient(launchWithCdp: boolean): void {
  desktopController.launchDesktopClient(launchWithCdp);
}

export function restartDesktopClients(launchWithCdp: boolean): void {
  desktopController.stopDesktopClients();
  desktopController.launchDesktopClient(launchWithCdp);
}

export function registerProviderBridgeEnvironment(
  port = Number.parseInt(process.env.OPENCODEX_PORT || "8765", 10),
): boolean {
  return desktopController.registerProviderBridgeEnvironment(port);
}

export function unregisterProviderBridgeEnvironment(): void {
  desktopController.unregisterProviderBridgeEnvironment();
}
