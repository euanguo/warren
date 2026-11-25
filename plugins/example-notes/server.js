/**
 * 记忆插件后端（sandbox 运行时）。
 *
 * 定位：**agent 的外置记忆**。agent 的上下文会被压缩 / 清空，这个库不会。
 * 两类条目：`todo`（有状态机）与 `fact`（事实/信息）；两个作用域：本环境 / 全局。
 *
 * 这里没有 require / process / fetch —— sandbox 运行时只有 host API。
 * 数据在插件自己的 SQLite（`<coreDir>/plugins/<id>/data.db`）。
 */

/** SQLite 的行 → 严格 JSON（顺手挡掉 undefined / bigint，它们过不了核心的返回值校验） */
function toItem(row) {
  return {
    id: Number(row.id),
    scope: String(row.scope),
    envId: row.env_id === null || row.env_id === undefined ? null : String(row.env_id),
    kind: String(row.kind),
    title: String(row.title),
    body: String(row.body ?? ''),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    tags: String(row.tags ?? ''),
    sourceUrl: row.source_url === null || row.source_url === undefined ? null : String(row.source_url),
    sourceTitle: row.source_title === null || row.source_title === undefined ? null : String(row.source_title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const COLUMNS =
  'id, scope, env_id, kind, title, body, status, priority, tags, source_url, source_title, created_at, updated_at';

/** 老的 `list` 命令的形状（回归套件盯着 `.result.notes.length`，不能改） */
const toLegacyNote = (item) => ({ id: item.id, text: item.title, createdAt: item.createdAt });

function tagList(tags) {
  return String(tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** 当前这次调用绑定的环境：命令走 ctx，rpc 走 input（前端在 input 里带） */
function envOf(input, ctx) {
  const fromInput = input && typeof input.environmentId === 'string' ? input.environmentId : '';
  return fromInput || (ctx && ctx.environmentId) || '';
}

async function query(host, options) {
  const where = [];
  const params = [];
  if (options.scope === 'env') {
    if (!options.envId) return [];
    where.push("scope = 'env' AND env_id = ?");
    params.push(options.envId);
  } else if (options.scope === 'global') {
    where.push("scope = 'global'");
  } else if (options.envId) {
    // 默认：本环境 + 全局
    where.push("(scope = 'global' OR (scope = 'env' AND env_id = ?))");
    params.push(options.envId);
  }
  if (options.kind) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  if (options.statuses && options.statuses.length) {
    where.push(`status IN (${options.statuses.map(() => '?').join(',')})`);
    params.push(...options.statuses);
  }
  if (options.search) {
    where.push('(title LIKE ? OR body LIKE ? OR tags LIKE ?)');
    const like = `%${options.search}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), 500) : 200;
  const rows = await host.storage.sql.query(
    `SELECT ${COLUMNS} FROM items ${clause} ORDER BY priority DESC, updated_at DESC LIMIT ${limit}`,
    params,
  );
  const items = rows.map(toItem);
  return options.tag ? items.filter((item) => tagList(item.tags).includes(options.tag)) : items;
}

async function insert(host, item) {
  const now = new Date().toISOString();
  await host.storage.sql.run(
    `INSERT INTO items (scope, env_id, kind, title, body, status, priority, tags, source_url, source_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.scope,
      item.scope === 'env' ? item.envId : null,
      item.kind,
      item.title,
      item.body,
      item.kind === 'todo' ? 'open' : 'open',
      item.priority,
      item.tags,
      item.sourceUrl,
      item.sourceTitle,
      now,
      now,
    ],
  );
  await host.signal.publish('changed', { action: 'add' });
}

/**
 * 给 agent 的压缩摘要 —— **一次调用就能塞进上下文**，不用它自己拼三个查询。
 * 这是这个插件存在的理由：todo 是状态机（能回答「还剩什么没做」），不是一堆自由文本。
 */
function renderContext(envId, todos, facts) {
  const lines = [`环境 ${envId || '(未绑定)'} · 待办 ${todos.length} · 记忆 ${facts.length}`];
  lines.push('', '待办：');
  if (!todos.length) lines.push('- （没有未完成的待办）');
  for (const item of todos) {
    const tags = tagList(item.tags)
      .map((tag) => `#${tag}`)
      .join(' ');
    const where = item.scope === 'global' ? '（全局）' : '';
    lines.push(
      `- [${item.status}] ${item.title}${where}${tags ? ` ${tags}` : ''}${item.priority ? ` p${item.priority}` : ''}`,
    );
    if (item.body) lines.push(`  ${item.body.split('\n')[0]}`);
  }
  lines.push('', '记忆：');
  if (!facts.length) lines.push('- （还没有记下什么）');
  for (const item of facts) {
    const where = item.scope === 'global' ? '（全局）' : '';
    lines.push(`- ${item.title}${where}${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  async activate(ctx) {
    await ctx.host.storage.sql.migrate([
      'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)',
      /*
       * 下标 1：items 表 + 把老的 notes 一次性搬进来（老的没有环境概念，当全局记忆）。
       * migrate 按下标记录已执行，所以这段只会跑一次。
       */
      `CREATE TABLE IF NOT EXISTS items (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         scope TEXT NOT NULL,
         env_id TEXT,
         kind TEXT NOT NULL,
         title TEXT NOT NULL,
         body TEXT NOT NULL DEFAULT '',
         status TEXT NOT NULL DEFAULT 'open',
         priority INTEGER NOT NULL DEFAULT 0,
         tags TEXT NOT NULL DEFAULT '',
         source_url TEXT,
         source_title TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS items_scope ON items (scope, env_id, kind, status, priority DESC, updated_at DESC);
       INSERT INTO items (scope, env_id, kind, title, body, status, priority, tags, created_at, updated_at)
         SELECT 'global', NULL, 'fact', text, '', 'open', 0, '', created_at, created_at FROM notes;`,
    ]);
    await ctx.host.log.info('记忆库已就绪');
  },

  // ── 命令（agent 走 `warren plugin run com.example.notes <cmd> --env <env>`）──

  /** 核心：这个环境现在该干什么 + 已经知道什么 */
  async context(ctx) {
    const envId = envOf(ctx.input, ctx);
    const todos = await query(ctx.host, { envId, kind: 'todo', statuses: ['open', 'doing'], limit: 50 });
    const facts = await query(ctx.host, { envId, kind: 'fact', limit: 20 });
    return { envId, todos, facts, text: renderContext(envId, todos, facts) };
  },

  async add(ctx) {
    const input = ctx.input || {};
    const title = String(input.title || '').trim();
    if (!title) throw Object.assign(new Error('title 不能为空'), { code: 'MEMORY_EMPTY' });
    const kind = input.kind === 'todo' ? 'todo' : 'fact';
    const scope = input.scope === 'global' ? 'global' : 'env';
    const envId = envOf(input, ctx);
    if (scope === 'env' && !envId) {
      throw Object.assign(new Error('scope=env 需要 --env=<环境>'), { code: 'MEMORY_NO_ENV' });
    }
    await insert(ctx.host, {
      scope,
      envId,
      kind,
      title,
      body: String(input.body || ''),
      priority: Number(input.priority) || 0,
      tags: Array.isArray(input.tags) ? input.tags.join(',') : String(input.tags || ''),
      sourceUrl: typeof input.url === 'string' ? input.url : null,
      sourceTitle: null,
    });
    return { items: await query(ctx.host, { envId, limit: 200 }) };
  },

  async list(ctx) {
    const input = ctx.input || {};
    const envId = envOf(input, ctx);
    const items = await query(ctx.host, {
      envId,
      scope: input.scope === 'global' ? 'global' : undefined,
      kind: input.kind,
      statuses: input.status ? [String(input.status)] : undefined,
      tag: input.tag ? String(input.tag) : undefined,
      limit: input.limit,
    });
    // `notes` 是老的形状：回归套件与既有脚本盯着它
    return { items, notes: items.map(toLegacyNote) };
  },

  async search(ctx) {
    const input = ctx.input || {};
    const envId = envOf(input, ctx);
    return { items: await query(ctx.host, { envId, search: String(input.query || ''), limit: input.limit }) };
  },

  async update(ctx) {
    const input = ctx.input || {};
    const id = Number(input.id);
    if (!id) throw Object.assign(new Error('update 需要 id'), { code: 'MEMORY_NO_ID' });
    const sets = [];
    const params = [];
    for (const [key, column] of [
      ['title', 'title'],
      ['body', 'body'],
      ['tags', 'tags'],
    ]) {
      if (typeof input[key] === 'string') {
        sets.push(`${column} = ?`);
        params.push(input[key]);
      }
    }
    if (input.priority !== undefined) {
      sets.push('priority = ?');
      params.push(Number(input.priority) || 0);
    }
    if (!sets.length) throw Object.assign(new Error('没有要改的字段'), { code: 'MEMORY_NO_FIELDS' });
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), id);
    await ctx.host.storage.sql.run(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, params);
    await ctx.host.signal.publish('changed', { action: 'update' });
    return { items: await query(ctx.host, { envId: envOf(input, ctx), limit: 200 }) };
  },

  async setStatus(ctx) {
    const input = ctx.input || {};
    const id = Number(input.id);
    const status = String(input.status || '');
    if (!id || !['open', 'doing', 'done', 'dropped'].includes(status)) {
      throw Object.assign(new Error('setStatus 需要 id 与 open|doing|done|dropped'), { code: 'MEMORY_BAD_STATUS' });
    }
    await ctx.host.storage.sql.run('UPDATE items SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      new Date().toISOString(),
      id,
    ]);
    await ctx.host.signal.publish('changed', { action: 'status' });
    return { items: await query(ctx.host, { envId: envOf(input, ctx), limit: 200 }) };
  },

  async remove(ctx) {
    const id = Number((ctx.input || {}).id);
    if (!id) throw Object.assign(new Error('remove 需要 id'), { code: 'MEMORY_NO_ID' });
    await ctx.host.storage.sql.run('DELETE FROM items WHERE id = ?', [id]);
    await ctx.host.signal.publish('changed', { action: 'remove' });
    return { items: await query(ctx.host, { envId: envOf(ctx.input, ctx), limit: 200 }) };
  },

  /** 把**当前页面**记成一条记忆（原来叫 addNote） */
  async remember(ctx) {
    const input = ctx.input || {};
    const envId = envOf(input, ctx);
    const title = (await ctx.host.browser.title()) || '(无标题)';
    const url = await ctx.host.browser.url();
    await insert(ctx.host, {
      scope: 'env',
      envId,
      kind: input.kind === 'todo' ? 'todo' : 'fact',
      title: String(input.title || title),
      body: String(input.body || ''),
      priority: Number(input.priority) || 0,
      tags: String(input.tags || ''),
      sourceUrl: url,
      sourceTitle: title,
    });
    await ctx.host.ui.notify(`已记下：${String(input.title || title)}`);
    return { items: await query(ctx.host, { envId, limit: 200 }) };
  },

  /** 老命令，保留（回归套件与既有脚本在用） */
  async addNote(ctx) {
    const envId = envOf(ctx.input, ctx);
    const title = `${(await ctx.host.browser.title()) || '(无标题)'} — ${await ctx.host.browser.url()}`;
    await insert(ctx.host, {
      scope: 'env',
      envId,
      kind: 'fact',
      title,
      body: '',
      priority: 0,
      tags: '',
      sourceUrl: await ctx.host.browser.url(),
      sourceTitle: await ctx.host.browser.title(),
    });
    await ctx.host.ui.notify(`已存成笔记：${title}`);
    return { text: title, notes: (await query(ctx.host, { envId, limit: 200 })).map(toLegacyNote) };
  },

  async clear(ctx) {
    await ctx.host.storage.sql.exec('DELETE FROM items');
    await ctx.host.storage.sql.exec('DELETE FROM notes');
    await ctx.host.signal.publish('changed', { action: 'clear' });
    return { ok: true };
  },

  // ── rpc（插件前端调）────────────────────────────────────────────
  rpc: {
    async list(input, ctx) {
      const envId = envOf(input, ctx);
      const items = await query(ctx.host, {
        envId,
        scope: input && input.scope === 'global' ? 'global' : undefined,
        kind: input && input.kind,
        statuses: input && input.status ? [String(input.status)] : undefined,
        tag: input && input.tag ? String(input.tag) : undefined,
        limit: input && input.limit,
      });
      // 面板要一个「按环境过滤」的下拉，顺带把环境表带回去（一条 rpc 就够，不多开一条）
      const environments = (await ctx.host.environment.list()).map((env) => ({
        id: String(env.id),
        name: String(env.name),
      }));
      return { items, notes: items.map(toLegacyNote), environments };
    },

    async context(input, ctx) {
      const envId = envOf(input, ctx);
      const todos = await query(ctx.host, { envId, kind: 'todo', statuses: ['open', 'doing'], limit: 50 });
      const facts = await query(ctx.host, { envId, kind: 'fact', limit: 20 });
      return { envId, todos, facts, text: renderContext(envId, todos, facts) };
    },

    async add(input, ctx) {
      const title = String((input && input.title) || '').trim();
      if (!title) throw Object.assign(new Error('内容不能为空'), { code: 'MEMORY_EMPTY' });
      const scope = input && input.scope === 'global' ? 'global' : 'env';
      const envId = envOf(input, ctx);
      if (scope === 'env' && !envId) {
        throw Object.assign(new Error('需要先选一个环境'), { code: 'MEMORY_NO_ENV' });
      }
      await insert(ctx.host, {
        scope,
        envId,
        kind: input && input.kind === 'todo' ? 'todo' : 'fact',
        title,
        body: String((input && input.body) || ''),
        priority: Number(input && input.priority) || 0,
        tags: String((input && input.tags) || ''),
        sourceUrl: null,
        sourceTitle: null,
      });
      return { items: await query(ctx.host, { envId, limit: 200 }) };
    },

    async update(input, ctx) {
      return module.exports.update({ host: ctx.host, input, environmentId: envOf(input, ctx) });
    },

    async setStatus(input, ctx) {
      return module.exports.setStatus({ host: ctx.host, input, environmentId: envOf(input, ctx) });
    },

    async remove(input, ctx) {
      return module.exports.remove({ host: ctx.host, input, environmentId: envOf(input, ctx) });
    },

    async remember(input, ctx) {
      return module.exports.remember({ host: ctx.host, input, environmentId: envOf(input, ctx) });
    },

    /** 只回计数；标题 / 过滤 / secret 是否配置由前端从 app.settings 读。 */
    async stats(_input, ctx) {
      const rows = await ctx.host.storage.sql.query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN kind = 'todo' AND status IN ('open','doing') THEN 1 ELSE 0 END) AS todos,
           SUM(CASE WHEN kind = 'fact' THEN 1 ELSE 0 END) AS facts
         FROM items`,
      );
      const row = rows[0] || {};
      return {
        total: Number(row.total || 0),
        todos: Number(row.todos || 0),
        facts: Number(row.facts || 0),
      };
    },
  },
};
