/**
 * 应用设置、跨环境地址历史、按域偏好、站点记忆与只读 Saved Flows 仓储。
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings,
  DomainPref,
  SavedFlowRecord,
  SavedFlowSpec,
  SavedFlowSummary,
  SiteNote,
  UrlHistoryEntry,
  ViewportPresetId,
} from '../../shared/types';
import { tx } from '../db.ts';
import { toAppSettings } from '../domain/approval.ts';
import {
  assertNoteSafe,
  normalizeSiteKey,
  optionalText,
  rowToUrlHistory,
  URL_HISTORY_LIMIT,
  warnStore,
  type Row,
} from './common.ts';

const URL_HISTORY_PRUNE_EVERY = 50;

export class SiteMemoryRepository {
  #db: () => DatabaseSync;
  #urlHistoryWrites = 0;

  constructor(getDb: () => DatabaseSync) {
    this.#db = getDb;
  }

  appSettings(): AppSettings {
    const rows = this.#db().prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const raw: Record<string, string> = {};
    for (const row of rows) raw[row.key] = row.value;
    return toAppSettings(raw);
  }

  setAppSettings(patch: Partial<AppSettings>): AppSettings {
    const db = this.#db();
    const now = new Date().toISOString();
    tx(db, () => {
      const statement = db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)');
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        statement.run(key, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value), now);
      }
    });
    return this.appSettings();
  }

  recordUrlHistory(rawUrl: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || rawUrl.length > 8192) return;
    const now = new Date().toISOString();
    const db = this.#db();
    try {
      this.#urlHistoryWrites += 1;
      const shouldPrune = this.#urlHistoryWrites % URL_HISTORY_PRUNE_EVERY === 0;
      tx(db, () => {
        db.prepare(
          `INSERT INTO url_history (url, visit_count, last_visited_at) VALUES (?, 1, ?)
           ON CONFLICT(url) DO UPDATE SET
             visit_count = url_history.visit_count + 1,
             last_visited_at = excluded.last_visited_at`,
        ).run(rawUrl, now);
        if (shouldPrune) {
          db.prepare(
            `DELETE FROM url_history WHERE url NOT IN (
               SELECT url FROM url_history ORDER BY last_visited_at DESC LIMIT ?
             )`,
          ).run(URL_HISTORY_LIMIT);
        }
      });
    } catch (error) {
      warnStore('recordUrlHistory', error);
    }
  }

  searchUrlHistory(query: string, limit = 8): UrlHistoryEntry[] {
    const q = query.trim().slice(0, 256);
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 8;
    const rows = this.#db()
      .prepare(
        `SELECT url, visit_count, last_visited_at
         FROM url_history
         WHERE ? = '' OR instr(lower(url), lower(?)) > 0
         ORDER BY CASE WHEN ? = '' THEN 0 ELSE instr(lower(url), lower(?)) END,
                  last_visited_at DESC
         LIMIT ?`,
      )
      .all(q, q, q, q, size) as Row[];
    return rows.map(rowToUrlHistory);
  }

  clearUrlHistory(): number {
    const result = this.#db().prepare('DELETE FROM url_history').run();
    return Number(result.changes ?? 0);
  }

  domainPref(envId: string, origin: string): DomainPref | undefined {
    const row = this.#db()
      .prepare(
        'SELECT env_id, origin, zoom_factor, viewport_preset, updated_at FROM domain_prefs WHERE env_id = ? AND origin = ?',
      )
      .get(envId, origin) as Row | undefined;
    if (!row) return undefined;
    const preset = optionalText(row.viewport_preset) as ViewportPresetId | undefined;
    return {
      envId: String(row.env_id),
      origin: String(row.origin),
      zoomFactor: Number(row.zoom_factor ?? 1),
      viewportPreset: preset,
      updatedAt: String(row.updated_at),
    };
  }

  listDomainPrefs(envId?: string): DomainPref[] {
    const db = this.#db();
    const rows = (
      envId === undefined
        ? db
            .prepare(
              'SELECT env_id, origin, zoom_factor, viewport_preset, updated_at FROM domain_prefs ORDER BY updated_at DESC',
            )
            .all()
        : db
            .prepare(
              'SELECT env_id, origin, zoom_factor, viewport_preset, updated_at FROM domain_prefs WHERE env_id = ? ORDER BY updated_at DESC',
            )
            .all(envId)
    ) as Row[];
    return rows.map((row) => ({
      envId: String(row.env_id),
      origin: String(row.origin),
      zoomFactor: Number(row.zoom_factor ?? 1),
      viewportPreset: optionalText(row.viewport_preset) as ViewportPresetId | undefined,
      updatedAt: String(row.updated_at),
    }));
  }

  setDomainPref(
    envId: string,
    origin: string,
    patch: { zoomFactor?: number; viewportPreset?: ViewportPresetId | null },
  ): DomainPref {
    const current = this.domainPref(envId, origin);
    const nextZoom =
      patch.zoomFactor !== undefined && Number.isFinite(patch.zoomFactor)
        ? Math.max(0.25, Math.min(5, Math.round(patch.zoomFactor * 100) / 100))
        : (current?.zoomFactor ?? 1);
    const nextPreset =
      patch.viewportPreset === null
        ? undefined
        : patch.viewportPreset !== undefined
          ? patch.viewportPreset
          : current?.viewportPreset;
    const updatedAt = new Date().toISOString();
    this.#db()
      .prepare(
        `INSERT INTO domain_prefs (env_id, origin, zoom_factor, viewport_preset, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(env_id, origin) DO UPDATE SET
           zoom_factor = excluded.zoom_factor,
           viewport_preset = excluded.viewport_preset,
           updated_at = excluded.updated_at`,
      )
      .run(envId, origin, nextZoom, nextPreset ?? null, updatedAt);
    return {
      envId,
      origin,
      zoomFactor: nextZoom,
      viewportPreset: nextPreset,
      updatedAt,
    };
  }

  removeDomainPref(envId: string, origin: string): boolean {
    const result = this.#db().prepare('DELETE FROM domain_prefs WHERE env_id = ? AND origin = ?').run(envId, origin);
    return Number(result.changes ?? 0) > 0;
  }

  getSiteNote(site: string): SiteNote | undefined {
    const key = normalizeSiteKey(site);
    const row = this.#db()
      .prepare('SELECT site, content, updated_by, updated_at FROM site_notes WHERE site = ?')
      .get(key) as Row | undefined;
    if (!row) return undefined;
    return {
      site: String(row.site),
      content: String(row.content),
      updatedBy: String(row.updated_by ?? 'human'),
      updatedAt: String(row.updated_at),
    };
  }

  listSiteNotes(): SiteNote[] {
    const rows = this.#db()
      .prepare('SELECT site, content, updated_by, updated_at FROM site_notes ORDER BY updated_at DESC')
      .all() as Row[];
    return rows.map((row) => ({
      site: String(row.site),
      content: String(row.content),
      updatedBy: String(row.updated_by ?? 'human'),
      updatedAt: String(row.updated_at),
    }));
  }

  matchSiteNotesForUrl(rawUrl: string): SiteNote[] {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return [];
    }
    if (!/^https?:$/i.test(parsed.protocol)) return [];
    const host = parsed.host.toLowerCase();
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const full = `${host}${cleanPath}`;
    return this.listSiteNotes()
      .filter((note) => {
        if (note.site === host || note.site === full) return true;
        if (note.site.startsWith(`${host}/`)) {
          return full === note.site || full.startsWith(`${note.site}/`);
        }
        return host.endsWith(`.${note.site}`);
      })
      .sort((a, b) => b.site.length - a.site.length);
  }

  setSiteNote(site: string, content: string, updatedBy = 'human'): SiteNote {
    const key = normalizeSiteKey(site);
    const safeContent = assertNoteSafe(content);
    const updatedAt = new Date().toISOString();
    this.#db()
      .prepare(
        `INSERT INTO site_notes (site, content, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET
           content = excluded.content,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(key, safeContent, updatedBy, updatedAt);
    return { site: key, content: safeContent, updatedBy, updatedAt };
  }

  appendSiteNote(site: string, text: string, updatedBy = 'human'): SiteNote {
    const key = normalizeSiteKey(site);
    const addition = assertNoteSafe(text);
    const existing = this.getSiteNote(key);
    const merged = existing ? `${existing.content}\n${addition}` : addition;
    return this.setSiteNote(key, merged, updatedBy);
  }

  removeSiteNote(site: string): boolean {
    const key = normalizeSiteKey(site);
    const result = this.#db().prepare('DELETE FROM site_notes WHERE site = ?').run(key);
    return Number(result.changes ?? 0) > 0;
  }

  getSavedFlow(name: string): SavedFlowRecord | undefined {
    const key = name.trim().toLowerCase();
    const row = this.#db()
      .prepare('SELECT name, site, spec_json, updated_by, updated_at FROM saved_flows WHERE name = ?')
      .get(key) as Row | undefined;
    if (!row) return undefined;
    try {
      return {
        name: String(row.name),
        site: String(row.site),
        spec: JSON.parse(String(row.spec_json)),
        updatedBy: String(row.updated_by ?? 'agent'),
        updatedAt: String(row.updated_at),
      };
    } catch (error) {
      warnStore('getSavedFlow', error);
      return undefined;
    }
  }

  listSavedFlows(): SavedFlowRecord[] {
    const rows = this.#db()
      .prepare('SELECT name, site, spec_json, updated_by, updated_at FROM saved_flows ORDER BY updated_at DESC')
      .all() as Row[];
    const out: SavedFlowRecord[] = [];
    for (const row of rows) {
      try {
        out.push({
          name: String(row.name),
          site: String(row.site),
          spec: JSON.parse(String(row.spec_json)),
          updatedBy: String(row.updated_by ?? 'agent'),
          updatedAt: String(row.updated_at),
        });
      } catch (error) {
        warnStore('listSavedFlows', error);
      }
    }
    return out;
  }

  saveFlow(name: string, site: string, spec: SavedFlowSpec, updatedBy = 'agent'): SavedFlowRecord {
    const key = name.trim().toLowerCase();
    const updatedAt = new Date().toISOString();
    this.#db()
      .prepare(
        `INSERT INTO saved_flows (name, site, spec_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           site = excluded.site,
           spec_json = excluded.spec_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(key, site, JSON.stringify(spec), updatedBy, updatedAt);
    return { name: key, site, spec, updatedBy, updatedAt };
  }

  removeSavedFlow(name: string): boolean {
    const key = name.trim().toLowerCase();
    const result = this.#db().prepare('DELETE FROM saved_flows WHERE name = ?').run(key);
    return Number(result.changes ?? 0) > 0;
  }

  /** 按当前 URL 的 host/path/子域匹配已保存的只读 Saved Flows（用于首访自动提示）。 */
  matchSavedFlowsForUrl(rawUrl: string): SavedFlowSummary[] {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return [];
    }
    if (!/^https?:$/i.test(parsed.protocol)) return [];
    const host = parsed.host.toLowerCase();
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const full = `${host}${cleanPath}`;
    return this.listSavedFlows()
      .filter((rec) => {
        const site = rec.site.trim().toLowerCase();
        if (!site) return false;
        if (site === host || site === full) return true;
        if (site.startsWith(`${host}/`)) return full === site || full.startsWith(`${site}/`);
        return host.endsWith(`.${site}`);
      })
      .sort((a, b) => b.site.length - a.site.length)
      .slice(0, 10)
      .map((rec) => {
        const params = new Set<string>();
        for (const match of rec.spec.urlTemplate.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
          if (match[1]) params.add(match[1]);
        }
        return {
          name: rec.name,
          site: rec.site,
          ...(rec.spec.description ? { description: rec.spec.description } : {}),
          params: [...params],
        };
      });
  }
}
