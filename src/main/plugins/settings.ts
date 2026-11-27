/**
 * 插件设置。
 *
 * - 普通设置落在 `warren.db` 的 `plugin_values`（`scope='setting'`）；
 * - `secret` 设置落在 `plugin_values`（`scope='secret'`），**永远不返回给插件前端**，
 *   插件后端用 `host.settings.get()` 取；前端只看到「已配置」。
 */
import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db.ts';
import type { PluginSettingDescriptor, PluginSettingValue } from '../../shared/types.ts';

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
  #pluginId: string;
  #db: DatabaseSync;
  #values: Record<string, string | number | boolean> = {};
  #secrets: Record<string, string> = {};

  constructor(options: { dir?: string; pluginId: string; db: DatabaseSync }) {
    this.#pluginId = options.pluginId;
    this.#db = options.db;
  }

  async load(): Promise<void> {
    this.#values = this.#readSettings();
    this.#secrets = this.#readSecrets();
  }

  #readSecrets(): Record<string, string> {
    const rows = this.#db
      .prepare("SELECT key, value FROM plugin_values WHERE plugin_id = ? AND scope = 'secret'")
      .all(this.#pluginId) as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (typeof row.value === 'string' && row.value.length > 0) out[row.key] = row.value;
    }
    return out;
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

  #putSecret(key: string, value: string): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO plugin_values (plugin_id, scope, key, value) VALUES (?, ?, ?, ?)')
      .run(this.#pluginId, 'secret', key, value);
  }

  #deleteSecret(key: string): void {
    this.#db
      .prepare("DELETE FROM plugin_values WHERE plugin_id = ? AND scope = 'secret' AND key = ?")
      .run(this.#pluginId, key);
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

  /** 给插件后端用：secret 仅在此处返回给插件后端。 */
  get(descriptors: PluginSettingDescriptor[]): Record<string, string | number | boolean | undefined> {
    const result: Record<string, string | number | boolean | undefined> = {};
    for (const descriptor of descriptors) {
      if (descriptor.type === 'secret') {
        result[descriptor.key] = this.#secrets[descriptor.key];
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
        configured: secret ? Boolean(this.#secrets[descriptor.key]) : this.#values[descriptor.key] !== undefined,
      };
    });
  }

  async set(descriptors: PluginSettingDescriptor[], key: string, raw: unknown): Promise<void> {
    const descriptor = descriptors.find((item) => item.key === key);
    if (!descriptor) {
      throw Object.assign(new Error(`插件没有声明设置 ${key}`), { code: 'PLUGIN_SETTING_UNKNOWN' });
    }
    if (descriptor.type === 'secret') {
      const text = String(raw ?? '');
      if (!text) return this.unset(descriptors, key);
      if (text.length > MAX_VALUE_LENGTH) {
        throw Object.assign(new Error(`设置 ${descriptor.key} 超过 ${MAX_VALUE_LENGTH} 字节`), {
          code: 'PLUGIN_SETTING_TOO_LARGE',
        });
      }
      this.#secrets[key] = text;
      this.#putSecret(key, text);
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
      delete this.#secrets[key];
      this.#deleteSecret(key);
      return;
    }
    delete this.#values[key];
    this.#save();
  }

  /** 卸载时把 secret 一起带走。 */
  async purge(_descriptors: PluginSettingDescriptor[]): Promise<void> {
    this.#secrets = {};
    this.#db.prepare("DELETE FROM plugin_values WHERE plugin_id = ? AND scope = 'secret'").run(this.#pluginId);
  }
}
