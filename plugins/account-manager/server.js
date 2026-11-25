/**
 * 账号管理插件后端。
 *
 * 按产品要求**明文存储**在插件自己的 data.db；不接 Vault。
 * 明文是存储层的产品例外，**不出这个边界**：
 * - 对外的账号对象一律走 `toPublicAccount`（没有 password，只有 hasPassword + 打码用户名）
 * - agent 要「用密码登录」只能调 `fill`：值在宿主内部流动，返回体只有填了哪几个字段
 * - 只有插件自己的界面（caller=ui）能调 `reveal` 看到明文
 * - `export` 需要调用方显式写 `{"confirm":"plaintext"}`，且只用于人工备份
 */

function toAccount(row) {
  const parseArray = (value) => {
    try {
      const parsed = JSON.parse(String(value || '[]'));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url ?? ''),
    username: String(row.username ?? ''),
    password: String(row.password ?? ''),
    note: String(row.note ?? ''),
    tags: String(row.tags ?? ''),
    displayAliases: parseArray(row.display_aliases),
    expectedUin: String(row.expected_uin ?? ''),
    appHints: parseArray(row.app_hints),
    loginProfile: String(row.login_profile ?? ''),
    manualVerificationHint: String(row.manual_verification_hint ?? ''),
    frameAwareFill: Boolean(row.frame_aware_fill),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 对外形状：没有 password。
 *
 * `usernameHint` 走宿主的 `vault.maskHint`（和 Vault 列表同一个打码规则，首字符 + 域名）。
 * sandbox 插件 import 不了主进程模块，所以规则由宿主提供一份。
 *
 * 保持**同步**：sandbox 运行时的 host 调用是同步的，这里必须同步返回，
 * 否则列表会变成 Promise 数组。真换成 host 运行时（Promise）时宁可显式失败，
 * 也不要把 `[object Promise]` 当成打码结果写进列表。
 */
function toPublicAccount(host, row) {
  const account = toAccount(row);
  const hint = host.vault.maskHint(account.username);
  if (typeof hint !== 'string') {
    throw Object.assign(new Error('host.vault.maskHint 没同步返回字符串（运行时可能换成了 host）'), {
      code: 'ACCOUNT_HINT_UNAVAILABLE',
    });
  }
  return {
    id: account.id,
    name: account.name,
    url: account.url,
    username: account.username,
    usernameHint: hint,
    hasPassword: account.password.length > 0,
    note: account.note,
    tags: account.tags,
    displayAliases: account.displayAliases,
    expectedUin: account.expectedUin,
    appHints: account.appHints,
    loginProfile: account.loginProfile,
    manualVerificationHint: account.manualVerificationHint,
    frameAwareFill: account.frameAwareFill,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

const COLUMNS = `id, name, url, username, password, note, tags,
  display_aliases, expected_uin, app_hints, login_profile, manual_verification_hint,
  frame_aware_fill,
  created_at, updated_at`;

/** 可被填充 / 揭示的字段。顺序就是填充顺序：先账号后密码。 */
const FIELDS = ['username', 'password'];

function text(input, key, max) {
  return raw(input, key, max).trim();
}

function raw(input, key, max) {
  const value = String((input && input[key]) || '');
  if (value.length > max) {
    throw Object.assign(new Error(`${key} 不能超过 ${max} 个字符`), { code: 'ACCOUNT_FIELD_TOO_LONG' });
  }
  return value;
}

function required(input, key, max) {
  const value = text(input, key, max);
  if (!value) throw Object.assign(new Error(`${key} 不能为空`), { code: 'ACCOUNT_FIELD_REQUIRED' });
  return value;
}

function stringArray(input, key, maxItems, maxLength) {
  if (input && input[key] === undefined) return undefined;
  const value = input && input[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw Object.assign(new Error(`${key} 必须是字符串数组，最多 ${maxItems} 项`), {
      code: 'ACCOUNT_FIELD_INVALID',
    });
  }
  return JSON.stringify(
    value.map((item) => {
      const textValue = String(item || '').trim();
      if (!textValue || textValue.length > maxLength) {
        throw Object.assign(new Error(`${key} 的每项必须为 1-${maxLength} 个字符`), {
          code: 'ACCOUNT_FIELD_INVALID',
        });
      }
      return textValue;
    }),
  );
}

function idOf(input) {
  const id = Number(input && input.id);
  if (!id) throw Object.assign(new Error('需要 id'), { code: 'ACCOUNT_NO_ID' });
  return id;
}

async function rowOf(host, id) {
  const rows = await host.storage.sql.query(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`, [id]);
  const row = rows[0];
  if (!row) throw Object.assign(new Error(`账号 ${id} 不存在`), { code: 'ACCOUNT_NOT_FOUND' });
  return row;
}

async function listAccounts(host, input) {
  const query = text(input, 'query', 200);
  const tag = text(input, 'tag', 100);
  const where = [];
  const params = [];
  if (query) {
    const like = `%${query}%`;
    where.push('(name LIKE ? OR url LIKE ? OR username LIKE ? OR note LIKE ? OR tags LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%${tag}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await host.storage.sql.query(
    `SELECT ${COLUMNS} FROM accounts ${clause} ORDER BY updated_at DESC, id DESC LIMIT 500`,
    params,
  );
  return { accounts: rows.map((row) => toPublicAccount(host, row)) };
}

async function create(host, input) {
  const now = new Date().toISOString();
  const account = {
    name: required(input, 'name', 200),
    url: text(input, 'url', 2000),
    username: text(input, 'username', 500),
    // 密码不能 trim：首尾空格也是密码的一部分
    password: raw(input, 'password', 4096),
    note: text(input, 'note', 20000),
    tags: text(input, 'tags', 500),
    display_aliases: stringArray(input, 'displayAliases', 50, 200) || '[]',
    expected_uin: text(input, 'expectedUin', 100),
    app_hints: stringArray(input, 'appHints', 50, 500) || '[]',
    login_profile: text(input, 'loginProfile', 100),
    manual_verification_hint: text(input, 'manualVerificationHint', 1000),
    frame_aware_fill: input && input.frameAwareFill === true ? 1 : 0,
  };
  await host.storage.sql.run(
    `INSERT INTO accounts (
       name, url, username, password, note, tags,
       display_aliases, expected_uin, app_hints, login_profile, manual_verification_hint,
       frame_aware_fill, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      account.name,
      account.url,
      account.username,
      account.password,
      account.note,
      account.tags,
      account.display_aliases,
      account.expected_uin,
      account.app_hints,
      account.login_profile,
      account.manual_verification_hint,
      account.frame_aware_fill,
      now,
      now,
    ],
  );
  await host.signal.publish('changed', { action: 'create' });
  return { ...(await listAccounts(host, input)), created: account.name };
}

async function update(host, input) {
  const id = idOf(input);
  const sets = [];
  const params = [];
  for (const [key, max] of [
    ['name', 200],
    ['url', 2000],
    ['username', 500],
    ['password', 4096],
    ['note', 20000],
    ['tags', 500],
  ]) {
    if (input[key] === undefined) continue;
    const value =
      key === 'name' ? required(input, key, max) : key === 'password' ? raw(input, key, max) : text(input, key, max);
    sets.push(`${key} = ?`);
    params.push(value);
  }
  const columnFor = {
    displayAliases: ['display_aliases', stringArray(input, 'displayAliases', 50, 200)],
    expectedUin: ['expected_uin', text(input, 'expectedUin', 100)],
    appHints: ['app_hints', stringArray(input, 'appHints', 50, 500)],
    loginProfile: ['login_profile', text(input, 'loginProfile', 100)],
    manualVerificationHint: ['manual_verification_hint', text(input, 'manualVerificationHint', 1000)],
    frameAwareFill: [
      'frame_aware_fill',
      input.frameAwareFill === undefined ? undefined : input.frameAwareFill === true ? 1 : 0,
    ],
  };
  for (const [key, [column, value]] of Object.entries(columnFor)) {
    if (input[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (!sets.length) throw Object.assign(new Error('没有要改的字段'), { code: 'ACCOUNT_NO_FIELDS' });
  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), id);
  await host.storage.sql.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  await host.signal.publish('changed', { action: 'update' });
  return listAccounts(host, input);
}

async function remove(host, input) {
  const id = idOf(input);
  await host.storage.sql.run('DELETE FROM accounts WHERE id = ?', [id]);
  await host.signal.publish('changed', { action: 'remove' });
  return listAccounts(host, input);
}

async function get(host, input) {
  const row = await rowOf(host, idOf(input));
  return { account: toPublicAccount(host, row) };
}

/** 明文导出必须由调用方显式确认（人工备份场景），避免 agent 顺手把全库打进上下文。 */
function requirePlaintextConfirm(input) {
  if (String((input && input.confirm) || '') === 'plaintext') return;
  throw Object.assign(new Error(`导出明文需要 --input='{"confirm":"plaintext"}'（仅供人工备份）`), {
    code: 'ACCOUNT_EXPORT_CONFIRM_REQUIRED',
  });
}

async function exportAccounts(host, input) {
  requirePlaintextConfirm(input);
  const rows = await host.storage.sql.query(`SELECT ${COLUMNS} FROM accounts ORDER BY id`);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: rows.map(toAccount),
  };
}

/**
 * 按 id 把账号填进页面字段。
 *
 * 值只从 SQLite 读到内存、再交给宿主的 `browser.fillSecret`，**不回传**。
 * 返回体只有「填了哪几个字段」和 id，连长度都不给。
 */
async function fill(host, input) {
  const id = idOf(input);
  const environmentId = String((input && input.environmentId) || '');
  if (!environmentId) {
    throw Object.assign(new Error('fill 需要 environmentId'), { code: 'ACCOUNT_NO_ENVIRONMENT' });
  }
  const requested = (input && input.fields) || {};
  const row = await rowOf(host, id);
  const filled = [];
  for (const field of FIELDS) {
    const target = requested[field];
    if (!target) continue;
    const value = String(row[field] ?? '');
    if (!value) {
      throw Object.assign(new Error(`账号 ${id} 没有 ${field}`), { code: 'ACCOUNT_FIELD_MISSING' });
    }
    await host.browser.fillSecret(environmentId, target, value);
    filled.push(field);
  }
  if (!filled.length) {
    throw Object.assign(new Error('fill 需要 fields: { username?: target, password?: target }'), {
      code: 'ACCOUNT_NO_FIELDS',
    });
  }
  return { filled, id };
}

/**
 * 明文只在插件自己的界面里出现。
 *
 * `caller` 来自宿主的调用上下文（渲染层 IPC = ui，CLI / agent = agent）。
 */
async function reveal(ctx, input) {
  if (ctx.caller !== 'ui') {
    throw Object.assign(new Error('reveal 只对插件界面开放；agent 通道请用 fill'), {
      code: 'ACCOUNT_REVEAL_UI_ONLY',
    });
  }
  const id = idOf(input);
  const field = String((input && input.field) || 'password');
  if (!FIELDS.includes(field)) {
    throw Object.assign(new Error(`reveal 只支持 ${FIELDS.join(' / ')}`), { code: 'ACCOUNT_FIELD_UNKNOWN' });
  }
  const row = await rowOf(host, id);
  return { id, field, value: String(row[field] ?? '') };
}

module.exports = {
  async activate(ctx) {
    await ctx.host.storage.sql.migrate([
      `CREATE TABLE IF NOT EXISTS accounts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         url TEXT NOT NULL DEFAULT '',
         username TEXT NOT NULL DEFAULT '',
         password TEXT NOT NULL DEFAULT '',
         note TEXT NOT NULL DEFAULT '',
         tags TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS accounts_updated ON accounts (updated_at DESC, id DESC);`,
    ]);
    const columns = await ctx.host.storage.sql.query('PRAGMA table_info(accounts)');
    const present = new Set(columns.map((column) => String(column.name)));
    for (const [name, definition] of [
      ['display_aliases', "TEXT NOT NULL DEFAULT '[]'"],
      ['expected_uin', "TEXT NOT NULL DEFAULT ''"],
      ['app_hints', "TEXT NOT NULL DEFAULT '[]'"],
      ['login_profile', "TEXT NOT NULL DEFAULT ''"],
      ['manual_verification_hint', "TEXT NOT NULL DEFAULT ''"],
      ['frame_aware_fill', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!present.has(name)) {
        await ctx.host.storage.sql.run(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
      }
    }
    await ctx.host.log.info('账号库已就绪（明文存储）');
  },

  list(ctx) {
    return listAccounts(ctx.host, ctx.input);
  },
  create(ctx) {
    return create(ctx.host, ctx.input);
  },
  update(ctx) {
    return update(ctx.host, ctx.input);
  },
  remove(ctx) {
    return remove(ctx.host, ctx.input);
  },
  fill(ctx) {
    return fill(ctx.host, ctx.input);
  },
  export(ctx) {
    return exportAccounts(ctx.host, ctx.input);
  },

  rpc: {
    list(input, ctx) {
      return listAccounts(ctx.host, input);
    },
    get(input, ctx) {
      return get(ctx.host, input);
    },
    create(input, ctx) {
      return create(ctx.host, input);
    },
    update(input, ctx) {
      return update(ctx.host, input);
    },
    remove(input, ctx) {
      return remove(ctx.host, input);
    },
    fill(input, ctx) {
      return fill(ctx.host, input);
    },
    reveal(input, ctx) {
      return reveal(ctx, input);
    },
    export(input, ctx) {
      return exportAccounts(ctx.host, input);
    },
  },
};
