/**
 * Platform abstraction for the Codex Desktop lifecycle.
 *
 * The provider split needs four things from the host OS:
 *   1. locating the OpenCodex provider bridge launcher,
 *   2. locating the native Codex app-server binary the bridge delegates to,
 *   3. publishing `CODEX_CLI_PATH` so Desktop launches the bridge instead,
 *   4. stopping/starting Desktop so it picks the bridge up.
 *
 * macOS and Windows solve all four completely differently, so each gets its own
 * controller instead of scattering `process.platform` checks through the gateway.
 */

/**
 * Which app-server the Desktop client is currently talking to.
 *
 * - `bridge`  — OpenCodex provider bridge is in front of the native binary.
 * - `native`  — Desktop is talking to the native Codex binary directly, so a
 *               third-party model slug would reach the official backend.
 * - `absent`  — No app-server is running.
 */
export type DesktopAppServerState = "bridge" | "native" | "absent";

export interface DesktopController {
  /** `process.platform` value this controller implements. */
  readonly platform: NodeJS.Platform;

  /**
   * Absolute path to the provider bridge launcher, or "" when unavailable.
   * On Windows this must be a real PE executable: the Codex Electron app spawns
   * it through `child_process.spawn` without a shell, which cannot run `.cmd`.
   */
  providerBridgePath(): string;

  /** Absolute path to the native Codex app-server binary, or "" when not found. */
  nativeCodexExecutablePath(): string;

  /** Absolute path to the Desktop client executable, or "" when not found. */
  desktopApplicationExecutable(): string;

  /** Whether Desktop is currently attached to the bridge, native, or nothing. */
  desktopAppServerState(): DesktopAppServerState;

  /** Terminate Desktop and any app-server it owns. */
  stopDesktopClients(): void;

  /**
   * Start Desktop so that it inherits the bridge environment.
   * Must refuse to launch unbridged when a managed third-party catalog is
   * active, otherwise a third-party slug reaches the official ChatGPT account
   * and surfaces the "model is not supported" error.
   */
  launchDesktopClient(launchWithCdp: boolean): void;

  /** Publish the bridge environment for future Desktop launches. */
  registerProviderBridgeEnvironment(port: number): boolean;

  /** Remove the bridge environment; already-running Desktop is left alone. */
  unregisterProviderBridgeEnvironment(): void;
}
