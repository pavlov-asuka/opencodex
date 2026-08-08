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
export { codexConfigPath, codexHomePath, BRIDGE_ENVIRONMENT_VARIABLES } from "./paths.js";

/**
 * Platforms without a Desktop client (Linux, containers, CI). The gateway still
 * runs as a plain HTTP gateway there; it just cannot drive a Desktop client.
 */
const unsupportedDesktopController: DesktopController = {
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

function selectController(): DesktopController {
  switch (process.platform) {
    case "darwin": return darwinDesktopController;
    case "win32": return win32DesktopController;
    default: return unsupportedDesktopController;
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
