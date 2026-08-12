/**
 * Credential Store for CodexBridge (OpenCodex V2)
 * Handles API Key resolution from providers.json, environment variables, or disk configuration.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProviderConfig } from "../core/types.js";
import { secretStore } from "../platform/secrets.js";
import { writeJsonAtomic } from "../core/atomic_write.js";

/**
 * Restore-native keeps provider identities, endpoints, and credentials, but
 * removes every selected-model field.  Keeping this as a pure transformation
 * makes it safe to reuse from the dashboard reset route and from tests.
 */
export function clearProviderModelSelections(providers: ProviderConfig[]): ProviderConfig[] {
  const modelFields = [
    "models",
    "selected_models",
    "active_models",
    "model_protocols",
    "model_metadata",
    "models_metadata",
    "model_context_windows",
    "context_windows",
    "last_test_status",
    "last_test_at",
    "last_test_message",
  ];

  return (Array.isArray(providers) ? providers : []).map((rawProvider: ProviderConfig) => {
    const provider: any = { ...(rawProvider as any), models: [] };
    for (const field of modelFields) {
      if (field !== "models") delete provider[field];
    }
    return provider as ProviderConfig;
  });
}

export class CredentialStore {
  private static readonly providerService = "OpenCodex Provider Credential";

  /**
   * Resolved per access rather than at module load. As a load-time constant it
   * ignored OPENCODEX_DATA_DIR entirely, so a test that redirected the data
   * directory still read and wrote the developer's real providers.json.
   */
  private static get providersConfigPath(): string {
    const dataDir = String(process.env.OPENCODEX_DATA_DIR || "").trim();
    return path.join(dataDir || path.join(os.homedir(), ".opencodex"), "providers.json");
  }
  private static cachedProviders: ProviderConfig[] = [];
  private static lastMtime = 0;

  public static loadProviders(): ProviderConfig[] {
    try {
      if (fs.existsSync(CredentialStore.providersConfigPath)) {
        const stat = fs.statSync(CredentialStore.providersConfigPath);
        if (stat.mtimeMs === CredentialStore.lastMtime && CredentialStore.cachedProviders.length > 0) {
          return CredentialStore.cachedProviders;
        }
        const raw = fs.readFileSync(CredentialStore.providersConfigPath, "utf-8");
        const data = JSON.parse(raw);
        CredentialStore.cachedProviders = Array.isArray(data) ? data : data.providers || [];
        if (secretStore.available) {
          let migrated = false;
          for (const provider of CredentialStore.cachedProviders as any[]) {
            if (provider.api_key && !provider.credential_ref) {
              try {
                CredentialStore.storeProviderSecret(provider, provider.api_key);
                migrated = true;
              } catch (error: any) {
                console.error(`[OpenCodex] Could not migrate ${provider.name} credential to ${secretStore.label}: ${error.message}`);
              }
            }
          }
          if (migrated) {
            // Opportunistic: the credentials are already in the OS store, so a
            // failed rewrite must not turn a successful load into an empty
            // provider list via the catch below.
            try {
              CredentialStore.saveProviders(CredentialStore.cachedProviders);
            } catch (error: any) {
              console.warn(`[OpenCodex] Credential migration could not be persisted: ${error.message}`);
            }
          }
        }
        CredentialStore.lastMtime = stat.mtimeMs;
        return CredentialStore.cachedProviders;
      }
    } catch {
      // Return empty array on read errors
    }
    return [];
  }

  public static setApiKey(providerName: string, apiKey: string): void {
    const providers = CredentialStore.loadProviders();
    let p = providers.find((item) => item.name === providerName);
    if (p) {
      CredentialStore.storeProviderSecret(p, apiKey);
    } else {
      const created: any = { name: providerName, type: "openai-compatible", baseUrl: "" };
      CredentialStore.storeProviderSecret(created, apiKey);
      providers.push(created);
    }
    CredentialStore.saveProviders(providers);
  }

  /** Attach a credential to a provider already present in the current list. */
  public static setApiKeyOnProviders(providers: ProviderConfig[], providerName: string, apiKey: string): void {
    const list = Array.isArray(providers) ? providers : [];
    const provider = list.find((item: any) => item?.name === providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} was not found while saving its credential`);
    }
    CredentialStore.storeProviderSecret(provider, apiKey);
    CredentialStore.saveProviders(list);
  }

  private static storeProviderSecret(provider: any, apiKey: string): void {
    if (!secretStore.available) {
      throw new Error(`OpenCodex cannot store provider credentials on ${process.platform}`);
    }
    const account = `provider:${String(provider.name || "custom")}`;
    CredentialStore.writeKeychainSecret(CredentialStore.providerService, account, apiKey);
    provider.credential_ref = `keychain:${CredentialStore.providerService}:${account}`;
    delete provider.api_key;
  }

  public static writeKeychainSecret(service: string, account: string, secret: string): void {
    if (!secretStore.available) {
      throw new Error(`OpenCodex cannot store credentials on ${process.platform}`);
    }
    secretStore.write(service, account, secret);
  }

  public static deleteKeychainSecret(service: string, account: string): void {
    if (!secretStore.available) return;
    secretStore.remove(service, account);
  }

  /**
   * Drop a provider's stored credential.
   *
   * Removing a provider used to leave its API key behind in the OS secret
   * store, so a deleted provider kept a live credential on disk indefinitely.
   * Safe to call for providers that never had one.
   */
  public static forgetProviderSecret(provider: any): void {
    const reference = String(provider?.credential_ref || "");
    const prefix = `keychain:${CredentialStore.providerService}:`;
    if (!reference.startsWith(prefix)) return;
    CredentialStore.deleteKeychainSecret(CredentialStore.providerService, reference.slice(prefix.length));
  }

  public static saveProviders(providers: ProviderConfig[]): void {
    try {
      const dir = path.dirname(CredentialStore.providersConfigPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const safeProviders = providers.map((provider: any) => {
        const { api_key: _apiKey, refresh_token: _refreshToken, ...safeProvider } = provider;
        return safeProvider;
      });
      writeJsonAtomic(CredentialStore.providersConfigPath, { providers: safeProviders });
      CredentialStore.cachedProviders = safeProviders;
      CredentialStore.lastMtime = fs.statSync(CredentialStore.providersConfigPath).mtimeMs;
    } catch (e: any) {
      // This used to be swallowed with a console.error, so the save endpoint
      // carried on and answered 200. A read-only directory, an antivirus lock
      // or a full disk produced "saved successfully" in the dashboard and an
      // empty configuration after the next restart — sometimes with the API
      // key already in the OS credential store, so the two disagreed.
      console.error(`Failed to save providers config: ${e.message}`);
      throw new Error(`无法写入服务商配置 ${CredentialStore.providersConfigPath}：${e.message}`);
    }
  }

  public static resolveApiKey(provider: ProviderConfig): string {
    if ((provider as any).credential_ref) {
      const fromKeychain = CredentialStore.readProviderSecret((provider as any).credential_ref);
      if (fromKeychain) return fromKeychain;
    }
    if (provider.api_key && provider.api_key.trim().length > 0) {
      return provider.api_key.trim();
    }
    if (provider.api_key_env && process.env[provider.api_key_env]) {
      return (process.env[provider.api_key_env] || "").trim();
    }
    return "";
  }

  private static readProviderSecret(reference: string): string {
    if (!secretStore.available || !reference.startsWith(`keychain:${CredentialStore.providerService}:`)) return "";
    const account = reference.slice(`keychain:${CredentialStore.providerService}:`.length);
    return secretStore.read(CredentialStore.providerService, account);
  }

  public static readKeychainSecret(service: string, reference: string | undefined): string {
    if (typeof reference !== "string" || !reference.startsWith(`keychain:${service}:`) || !secretStore.available) return "";
    const account = reference.slice(`keychain:${service}:`.length);
    return secretStore.read(service, account);
  }
}
