import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabases, openDatabase } from '../../src/main/db.ts';
import type { EnvironmentManager } from '../../src/main/environments.ts';
import { createHandlers } from '../../src/main/plugins/api/index.ts';
import type { HostApiDeps } from '../../src/main/plugins/api/types.ts';
import { PluginHost } from '../../src/main/plugins/host.ts';
import type { Store } from '../../src/main/store.ts';
import type { VaultStore } from '../../src/main/vault/store.ts';
import type { AppSettings } from '../../src/shared/types.ts';

export interface StubVaultOptions {
  available?: boolean;
  secrets?: Map<string, string>;
}

export function createStubVault(options: StubVaultOptions = {}): VaultStore {
  const records = options.secrets ?? new Map<string, string>();
  return {
    available: options.available ?? true,
    list: () =>
      [...records.keys()].map((ref) => ({
        ref,
        provider: 'test',
        label: ref,
      })),
    add: ({ label, secret }: { provider?: string; label: string; secret: { password?: string } }) => {
      if (secret.password !== undefined) records.set(label, secret.password);
      return { ref: label };
    },
    remove: (ref: string) => records.delete(ref),
    reveal: (ref: string) => ({ password: records.get(ref) }),
  } as unknown as VaultStore;
}

export function createStubStore(settingsPatch: Partial<AppSettings> = {}): {
  store: Store;
  records: Array<Record<string, unknown>>;
} {
  const records: Array<Record<string, unknown>> = [];
  const store = {
    record: (entry: Record<string, unknown>) => records.push(entry),
    appSettings: () => ({ controlPolicy: 'ask', pluginPolicy: 'ask', ...settingsPatch }),
  } as unknown as Store;
  return { store, records };
}

export function createTestPluginHost(
  root: string,
  options: {
    manager?: EnvironmentManager;
    vault?: VaultStore;
    store?: Store;
    appVersion?: string;
    reconnectBaseMs?: number;
    maxReconnectAttempts?: number;
    dbPath?: string;
    onChange?: () => void;
    onSignal?: (pluginId: string, channel: string, payload: unknown) => void;
  } = {},
): {
  host: PluginHost;
  db: DatabaseSync;
  cleanup: () => Promise<void>;
} {
  const db = openDatabase(options.dbPath ?? path.join(root, 'warren.db'));
  const host = new PluginHost({
    root: path.join(root, 'plugins'),
    manager: options.manager ?? ({} as EnvironmentManager),
    vault: options.vault ?? createStubVault({ available: false }),
    store: options.store ?? createStubStore().store,
    db,
    saveVault: async () => undefined,
    appVersion: options.appVersion ?? '0.1.0',
    reconnectBaseMs: options.reconnectBaseMs ?? 0,
    maxReconnectAttempts: options.maxReconnectAttempts,
    onChange: options.onChange,
    onSignal: options.onSignal,
  });
  return {
    host,
    db,
    cleanup: async () => {
      await host.dispose();
      closeDatabases();
    },
  };
}

export function buildHandlerDeps(
  overrides: Partial<HostApiDeps> & { pluginId: string; granted?: Set<string> },
): HostApiDeps {
  const granted = overrides.granted;
  return {
    pluginId: overrides.pluginId,
    currentEnvironmentId: overrides.currentEnvironmentId ?? (() => 'env-1'),
    require:
      overrides.require ??
      ((permission) => {
        if (granted && !granted.has(permission)) {
          throw Object.assign(new Error(`没有权限 ${permission}`), { code: 'PLUGIN_PERMISSION_DENIED' });
        }
      }),
    manager: overrides.manager ?? ({} as EnvironmentManager),
    vault: overrides.vault ?? createStubVault(),
    storage: overrides.storage ?? ({} as never),
    settings: overrides.settings ?? ({ get: () => ({}) } as never),
    descriptors: overrides.descriptors ?? [],
    record: overrides.record ?? (() => undefined),
    log: overrides.log ?? (() => undefined),
    signal: overrides.signal ?? (() => undefined),
    withLease: overrides.withLease ?? (async (_envId, fn) => fn('lease-1')),
    currentCaller: overrides.currentCaller,
    subscribeEvents: overrides.subscribeEvents,
    unsubscribeEvents: overrides.unsubscribeEvents,
  };
}

export function createTestHandlers(overrides: Partial<HostApiDeps> & { pluginId: string; granted?: Set<string> }) {
  return createHandlers(buildHandlerDeps(overrides));
}
