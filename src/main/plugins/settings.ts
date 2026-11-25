/**
 * 插件设置。
 *
 * - 非 secret 的值落在 `warren.db` 的 `plugin_values`（scope='setting'）；
 * - `secret` 的值走 Vault（safeStorage），**永远不返回给插件前端**，
 *   插件后端用 `host.settings.get()` 取；前端只看到「已配置」。
 *
 * 和 `vault.fill` 是同一个思路：秘密只在一个方向上流动。
 */
import { mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db.ts';
import type { PluginSettingDescriptor, PluginSettingValue } from '../../shared/types.ts';

export interface SettingsVault {
  available: boolean;
  list(): Array<{ ref: string; provider: string; label: string }>;
  add(input: { provider: string; label: string; secret: { password: string } }): { ref: string };
  reveal(ref: string): { password?: string };
  remove(ref: string): boolean;
}

const MAX_VALUE_LENGTH = 8 * 1024;

function coerce(descriptor: PluginSettingDescriptor, raw: unknown): string | number | boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (descriptor.type === 'number') {
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  if (descriptor.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  const value = String(raw);
  if (value.length > MAX_VALUE_LENGTH) {
    throw Object.assign(new Error(`设置 ${descriptor.key} 超过 ${MAX_VALUE_LENGTH} 字节`), {
      code: 'PLUGIN_SETTING_TOO_LARGE',
    });
  }
  if (descriptor.type === 'select' && descriptor.options && !descriptor.options.includes(value)) {
    throw Object.assign(new Error(`设置 ${descriptor.key} 只能是 ${descriptor.options.join(' / ')}`), {
      code: 'PLUGIN_SETTING_INVALID',
    });
  }
  return value;
}

export class PluginSettings {
  #dir: string;
  #pluginId: string;
  #vault: SettingsVault;
  #saveVault: () => Promise<void>;
  #db: DatabaseSync;
  #values: Record<string, string | number | boolean> = {};

  constructor(options: {
    dir: string;
    pluginId: string;
    vault: SettingsVault;
    saveVault: () => Promise<void>;
    db: DatabaseSync;
  }) {
    this.#dir = options.dir;
    this.#pluginId = options.pluginId;
    this.#vault = options.vault;
    this.#saveVault = options.saveVault;
    this.#db = options.db;
  }

  get #provider(): string {
    return `plugin:${this.#pluginId}`;
  }

  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    this.#values = this.#readSettings();
  }

  #readSettings(): Record<string, string | number | boolean> {
    const rows = this.#db
      .prepare("SELECT key, value FROM plugin_values WHERE plugin_id = ? AND scope = 'setting'")
      .all(this.#pluginId) as Array<{ key: string; value: string }>;
    const out: Record<string, string | number | boolean> = {};
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as string | number | boolean;
        if (['string', 'number', 'boolean'].includes(typeof parsed)) out[row.key] = parsed;
      } catch {
        // 坏值当没设过
      }
    }
    return out;
  }

  #save(): void {
    tx(this.#db, () => {
      this.#db.prepare("DELETE FROM plugin_values WHERE plugin_id = ? AND scope = 'setting'").run(this.#pluginId);
      const insert = this.#db.prepare(
        'INSERT OR REPLACE INTO plugin_values (plugin_id, scope, key, value) VALUES (?, ?, ?, ?)',
      );
      for (const [key, value] of Object.entries(this.#values)) {
        insert.run(this.#pluginId, 'setting', key, JSON.stringify(value));
      }
    });
  }

  #secretRef(key: string): string | undefined {
    return this.#vault.list().find((item) => item.provider === this.#provider && item.label === key)?.ref;
  }

  /** 描述符的默认值：没设过就补上，让插件第一次跑起来就有值。 */
  async seedDefaults(descriptors: PluginSettingDescriptor[]): Promise<void> {
    let changed = false;
    for (const descriptor of descriptors) {
      if (descriptor.type === 'secret' || descriptor.default === undefined) continue;
      if (this.#values[descriptor.key] === undefined) {
        this.#values[descriptor.key] = descriptor.default;
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  /** 给插件后端用：secret 在这里被解出来。 */
  get(descriptors: PluginSettingDescriptor[]): Record<string, string | number | boolean | undefined> {
    const result: Record<string, string | number | boolean | undefined> = {};
    for (const descriptor of descriptors) {
      if (descriptor.type === 'secret') {
        const ref = this.#secretRef(descriptor.key);
        result[descriptor.key] = ref ? this.#vault.reveal(ref).password : undefined;
        continue;
      }
      result[descriptor.key] = this.#values[descriptor.key] ?? descriptor.default;
    }
    return result;
  }

  /** 给渲染层用：secret 只报「有没有配」。 */
  list(descriptors: PluginSettingDescriptor[]): PluginSettingValue[] {
    return descriptors.map((descriptor) => {
      const secret = descriptor.type === 'secret';
      return {
        key: descriptor.key,
        label: descriptor.label,
        type: descriptor.type,
        description: descriptor.description,
        options: descriptor.options,
        value: secret ? undefined : (this.#values[descriptor.key] ?? descriptor.default),
        configured: secret ? Boolean(this.#secretRef(descriptor.key)) : this.#values[descriptor.key] !== undefined,
      };
    });
  }

  async set(descriptors: PluginSettingDescriptor[], key: string, raw: unknown): Promise<void> {
    const descriptor = descriptors.find((item) => item.key === key);
    if (!descriptor) {
      throw Object.assign(new Error(`插件没有声明设置 ${key}`), { code: 'PLUGIN_SETTING_UNKNOWN' });
    }
    if (descriptor.type === 'secret') {
      if (!this.#vault.available) {
        throw Object.assign(new Error('系统密钥存储不可用，secret 设置无法保存'), {
          code: 'VAULT_UNAVAILABLE',
        });
      }
      const text = String(raw ?? '');
      if (!text) return this.unset(descriptors, key);
      const ref = this.#secretRef(key);
      if (ref) this.#vault.remove(ref);
      this.#vault.add({ provider: this.#provider, label: key, secret: { password: text } });
      await this.#saveVault();
      return;
    }
    const value = coerce(descriptor, raw);
    if (value === undefined) {
      throw Object.assign(new Error(`设置 ${key} 的值不合法`), { code: 'PLUGIN_SETTING_INVALID' });
    }
    this.#values[key] = value;
    this.#save();
  }

  async unset(descriptors: PluginSettingDescriptor[], key: string): Promise<void> {
    const descriptor = descriptors.find((item) => item.key === key);
    if (!descriptor) return;
    if (descriptor.type === 'secret') {
      const ref = this.#secretRef(key);
      if (ref) {
        this.#vault.remove(ref);
        await this.#saveVault();
      }
      return;
    }
    delete this.#values[key];
    this.#save();
  }

  /** 卸载时把 secret 一起带走。 */
  async purge(descriptors: PluginSettingDescriptor[]): Promise<void> {
    for (const descriptor of descriptors) {
      if (descriptor.type !== 'secret') continue;
      const ref = this.#secretRef(descriptor.key);
      if (ref) this.#vault.remove(ref);
    }
    await this.#saveVault();
  }
}
