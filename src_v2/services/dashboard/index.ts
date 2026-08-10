import { secretStore } from "../../platform/secrets.js";
import { renderDashboardHtml } from "./shell.js";

/**
 * OpenCodex web control centre. The surface is intentionally dependency-free
 * so it can be served by the local helper and later embedded in a desktop shell.
 */
export function getDashboardHtml(): string {
  // Credentials go to the login Keychain on macOS and to DPAPI on Windows, so
  // the copy names whichever store this host actually uses instead of always
  // promising a Keychain.
  return renderDashboardHtml().replaceAll("macOS Keychain", secretStore.label);
}
