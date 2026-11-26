/**
 * 环境、分组、运行态与标签快照仓储（全同步 SQLite 事务操作，无伪 async）。
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Creator, Environment, EnvironmentConfig, Group } from '../../shared/types';
import { tx } from '../db.ts';
import {
  assertEnvironmentId,
  clampEnvironmentName,
  createEnvironmentConfig,
  safeEnvKey,
  toEnvironment,
  type EnvironmentPatch,
} from '../domain/environment.ts';
import {
  createGroup,
  detachGroupEnvironments,
  moveToGroup,
  nextOrder,
  renameGroup,
  reorderBy,
  setGroupCollapsed,
} from '../domain/group.ts';
import { rowToConfig, rowToGroup, warnStore, type RememberedTab, type Row, type RunningSnapshot } from './common.ts';

export class EnvironmentRepository {
  #dir: string;
  #db: () => DatabaseSync;

  constructor(dir: string, getDb: () => DatabaseSync) {
    this.#dir = dir;
    this.#db = getDb;
  }

  storagePathFor(id: string): string {
    return path.join(this.#dir, 'sessions', safeEnvKey(id));
  }

  insertConfig(config: EnvironmentConfig): void {
    this.#db()
      .prepare(
        `INSERT OR REPLACE INTO environments
           (id, name, storage_path, proxy, trusted_ca, created_by, approval, start_url, headed, group_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.id,
        config.name,
        config.storagePath,
        config.proxy ?? null,
        config.trustedCa ?? null,
        config.createdBy,
        config.approval ?? null,
        config.startUrl ?? null,
        config.headed ? 1 : 0,
        config.groupId ?? null,
        config.order,
        config.createdAt,
        config.updatedAt,
      );
  }

  insertGroup(group: Group): void {
    this.#db()
      .prepare(
        `INSERT OR REPLACE INTO groups (id, name, sort_order, collapsed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(group.id, group.name, group.order, group.collapsed ? 1 : 0, group.createdAt, group.updatedAt);
  }

  #configsInGroup(groupId?: string): EnvironmentConfig[] {
    const db = this.#db();
    const rows =
      groupId === undefined
        ? db.prepare('SELECT * FROM environments WHERE group_id IS NULL').all()
        : db.prepare('SELECT * FROM environments WHERE group_id = ?').all(groupId);
    return (rows as Row[]).map(rowToConfig);
  }

  list(): Environment[] {
    const rows = this.#db().prepare('SELECT * FROM environments ORDER BY sort_order, rowid').all() as Row[];
    return rows.map((row) => toEnvironment(rowToConfig(row)));
  }

  get(id: string): Environment | undefined {
    const config = this.configFor(id);
    return config ? toEnvironment(config) : undefined;
  }

  configFor(id: string): EnvironmentConfig | undefined {
    const row = this.#db().prepare('SELECT * FROM environments WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToConfig(row) : undefined;
  }

  create(input: {
    id: string;
    name?: string;
    proxy?: string;
    startUrl?: string;
    headed?: boolean;
    groupId?: string;
    createdBy?: Creator;
  }): Environment {
    assertEnvironmentId(input.id);
    if (this.configFor(input.id)) {
      throw Object.assign(new Error(`environment ${input.id} already exists`), { code: 'ENV_EXISTS' });
    }
    if (input.groupId && !this.groupFor(input.groupId)) {
      throw Object.assign(new Error(`unknown group ${input.groupId}`), { code: 'GROUP_NOT_FOUND' });
    }
    const config = createEnvironmentConfig({
      id: input.id,
      name: input.name,
      storagePath: this.storagePathFor(input.id),
      proxy: input.proxy,
      startUrl: input.startUrl,
      headed: input.headed,
      groupId: input.groupId,
      createdBy: input.createdBy,
      order: nextOrder(this.#configsInGroup(input.groupId)),
    });
    this.insertConfig(config);
    return toEnvironment(config);
  }

  update(id: string, patch: EnvironmentPatch): Environment {
    const config = this.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    const next: EnvironmentConfig = {
      ...config,
      ...(patch.name === undefined ? {} : { name: clampEnvironmentName(patch.name) }),
      ...(patch.proxy === undefined ? {} : { proxy: patch.proxy ?? undefined }),
      ...(patch.trustedCa === undefined ? {} : { trustedCa: patch.trustedCa ?? undefined }),
      ...(patch.approval === undefined ? {} : { approval: patch.approval ?? undefined }),
      ...(patch.startUrl === undefined ? {} : { startUrl: patch.startUrl }),
      ...(patch.headed === undefined ? {} : { headed: patch.headed }),
      updatedAt: new Date().toISOString(),
    };
    this.insertConfig(next);
    return toEnvironment(next);
  }

  remove(id: string): void {
    const db = this.#db();
    tx(db, () => {
      db.prepare('DELETE FROM environments WHERE id = ?').run(id);
      db.prepare('DELETE FROM dormant_state WHERE env_id = ?').run(id);
      db.prepare('DELETE FROM running_state WHERE env_id = ?').run(id);
      db.prepare('DELETE FROM env_tabs WHERE env_id = ?').run(id);
      db.prepare('DELETE FROM domain_prefs WHERE env_id = ?').run(id);
    });
  }

  moveToGroup(id: string, groupId: string | undefined): Environment {
    const config = this.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    const moved = moveToGroup(config, groupId, this.listGroups(), this.list());
    this.insertConfig(moved);
    return toEnvironment(moved);
  }

  reorderEnvironments(groupId: string | undefined, orderedIds: string[]): void {
    const inGroup = this.#configsInGroup(groupId);
    const orderById = new Map(reorderBy(inGroup, orderedIds).map((item, index) => [item.id, index]));
    const now = new Date().toISOString();
    const db = this.#db();
    tx(db, () => {
      const stmt = db.prepare('UPDATE environments SET sort_order = ?, updated_at = ? WHERE id = ?');
      for (const [id, order] of orderById) stmt.run(order, now, id);
    });
  }

  listGroups(): Group[] {
    const rows = this.#db().prepare('SELECT * FROM groups ORDER BY sort_order, rowid').all() as Row[];
    return rows.map(rowToGroup);
  }

  groupFor(id: string): Group | undefined {
    const row = this.#db().prepare('SELECT * FROM groups WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToGroup(row) : undefined;
  }

  createGroup(input: { id?: string; name: string }): Group {
    const group = createGroup({ ...input, order: nextOrder(this.listGroups()) });
    if (this.groupFor(group.id)) {
      throw Object.assign(new Error(`group ${group.id} already exists`), { code: 'GROUP_EXISTS' });
    }
    this.insertGroup(group);
    return group;
  }

  renameGroup(id: string, name: string): Group {
    const group = this.groupFor(id);
    if (!group) throw Object.assign(new Error(`unknown group ${id}`), { code: 'GROUP_NOT_FOUND' });
    const renamed = renameGroup(group, name);
    this.insertGroup(renamed);
    return renamed;
  }

  setGroupCollapsed(id: string, collapsed: boolean): Group {
    const group = this.groupFor(id);
    if (!group) throw Object.assign(new Error(`unknown group ${id}`), { code: 'GROUP_NOT_FOUND' });
    const next = setGroupCollapsed(group, collapsed);
    this.insertGroup(next);
    return next;
  }

  removeGroup(id: string): { detached: number } {
    if (!this.groupFor(id)) throw Object.assign(new Error(`unknown group ${id}`), { code: 'GROUP_NOT_FOUND' });
    const detached = this.#configsInGroup(id).length;
    const next = detachGroupEnvironments(this.list(), id);
    const db = this.#db();
    tx(db, () => {
      for (const config of next) this.insertConfig(config);
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    });
    return { detached };
  }

  reorderGroups(orderedIds: string[]): void {
    const orderById = new Map(reorderBy(this.listGroups(), orderedIds).map((group, index) => [group.id, index]));
    const now = new Date().toISOString();
    const db = this.#db();
    tx(db, () => {
      const stmt = db.prepare('UPDATE groups SET sort_order = ?, updated_at = ? WHERE id = ?');
      for (const [id, order] of orderById) stmt.run(order, now, id);
    });
  }

  runningSnapshot(): RunningSnapshot {
    const db = this.#db();
    const rows = db.prepare('SELECT env_id, selected FROM running_state').all() as Row[];
    const selected = rows.find((row) => row.selected === 1)?.env_id;
    const dormant = (db.prepare('SELECT env_id FROM dormant_state').all() as Row[]).map((row) => String(row.env_id));
    return {
      running: rows.map((row) => String(row.env_id)),
      selected: selected === undefined ? undefined : String(selected),
      dormant,
    };
  }

  saveRunning(snapshot: RunningSnapshot): void {
    try {
      const db = this.#db();
      tx(db, () => {
        db.exec('DELETE FROM running_state');
        const insert = db.prepare('INSERT OR REPLACE INTO running_state (env_id, selected) VALUES (?, ?)');
        for (const id of snapshot.running) insert.run(id, snapshot.selected === id ? 1 : 0);
        db.exec('DELETE FROM dormant_state');
        const insertDormant = db.prepare('INSERT OR REPLACE INTO dormant_state (env_id, slept_at) VALUES (?, ?)');
        for (const id of snapshot.dormant ?? []) insertDormant.run(id, new Date().toISOString());
      });
    } catch (error) {
      warnStore('saveRunning', error);
    }
  }

  tabsFor(envId: string): RememberedTab[] {
    const rows = this.#db()
      .prepare('SELECT space, url, active FROM env_tabs WHERE env_id = ? ORDER BY position')
      .all(envId) as Row[];
    return rows.map((row) => ({
      space: row.space === 'agent' ? 'agent' : 'person',
      url: String(row.url),
      active: row.active === 1,
    }));
  }

  saveTabs(envId: string, tabs: RememberedTab[]): void {
    try {
      const db = this.#db();
      tx(db, () => {
        db.prepare('DELETE FROM env_tabs WHERE env_id = ?').run(envId);
        const insert = db.prepare(
          'INSERT OR REPLACE INTO env_tabs (env_id, position, space, url, active) VALUES (?, ?, ?, ?, ?)',
        );
        tabs.forEach((tab, index) => insert.run(envId, index, tab.space, tab.url, tab.active ? 1 : 0));
      });
    } catch (error) {
      warnStore('saveTabs', error);
    }
  }
}
