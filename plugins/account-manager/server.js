/**
 * 账号管理插件后端（sandbox vm 运行时，零外部依赖）。
 *
 * 按产品要求**明文存储**在插件自己的 data.db；不接 Vault。
 * 明文是存储层的产品例外，**不出这个边界**：
 * - 对外的账号对象一律走 `toPublicAccount`（永远没有 password / totpSecret / extraFields 明文）
 * - `caller !== 'ui'`（agent / CLI）时**连明文 username 也不返回**，只给 `usernameHint`
 * - agent 要「用密码/TOTP 登录」只能调 `fill` / `autoFill`：值在宿主内部流动，返回体只有填了哪几个字段
 * - 只有插件自己的界面（caller === 'ui'）能调 `reveal` 与 `totpCode`
 * - `export` 需要调用方显式写 `{"confirm":"plaintext"}`，且仅供人工备份
 */

const RESERVED_FIELD_KEYS = new Set(['username', 'password', 'totp', 'submit', 'extra']);
const TWO_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.au',
  'net.au',
  'org.au',
  'com.tw',
  'com.hk',
  'co.kr',
  'com.sg',
  'com.br',
]);

function accountError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      err[key] = value;
    }
  }
  return err;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseStringMap(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!isPlainObject(parsed)) return {};
    const out = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === 'string') out[key] = item;
      else if (item !== null && item !== undefined) out[key] = String(item);
    }
    return out;
  } catch {
    return {};
  }
}

function parseSelectors(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!isPlainObject(parsed)) return {};
    const out = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === 'string' && item.trim()) {
        out[key] = item.trim();
      } else if (isPlainObject(item)) {
        out[key] = item;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function localMaskHint(username) {
  const value = typeof username === 'string' ? username : String(username ?? '');
  if (!value) return '';
  const atIndex = value.indexOf('@');
  if (atIndex > 0) {
    return `${value.slice(0, 1)}***@${value.slice(atIndex + 1)}`;
  }
  return `${value.slice(0, 1)}***`;
}

function resolveUsernameHint(host, username) {
  if (host && host.vault && typeof host.vault.maskHint === 'function') {
    const hint = host.vault.maskHint(username);
    if (hint && typeof hint.then === 'function') {
      throw accountError('ACCOUNT_HINT_UNAVAILABLE', 'host.vault.maskHint 没同步返回字符串（运行时可能换成了 host）');
    }
    if (typeof hint === 'string') return hint;
  }
  if (host && host.vault && typeof host.vault.mask === 'function') {
    const hint = host.vault.mask(username);
    if (typeof hint === 'string') return hint;
  }
  return localMaskHint(username);
}

function toAccount(row) {
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url ?? ''),
    urls: parseArray(row.urls),
    username: String(row.username ?? ''),
    password: String(row.password ?? ''),
    totpSecret: String(row.totp_secret ?? ''),
    extraFields: parseStringMap(row.extra_fields),
    note: String(row.note ?? ''),
    tags: String(row.tags ?? ''),
    displayAliases: parseArray(row.display_aliases),
    expectedUin: String(row.expected_uin ?? ''),
    appHints: parseArray(row.app_hints),
    loginProfile: String(row.login_profile ?? ''),
    manualVerificationHint: String(row.manual_verification_hint ?? ''),
    frameAwareFill: Boolean(row.frame_aware_fill),
    selectors: parseSelectors(row.selectors),
    allowedHosts: parseArray(row.allowed_hosts),
    envIds: parseArray(row.env_ids),
    pinned: Boolean(row.pinned),
    useCount: Number(row.use_count ?? 0) || 0,
    lastUsedAt: String(row.last_used_at ?? ''),
    deletedAt: String(row.deleted_at ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 对外投影：永远不包含 password / totpSecret / extraFields 的明文值。
 * `caller === 'ui'` 时保留 `username` 供界面展示与复制；
 * `caller !== 'ui'`（agent 或缺省）时省略 `username`，仅保留 `usernameHint`。
 */
function toPublicAccount(host, row, caller) {
  const account = toAccount(row);
  const hint = resolveUsernameHint(host, account.username);
  const extraFieldKeys = Object.keys(account.extraFields);
  const hasTotp = account.totpSecret.length > 0;
  return {
    id: account.id,
    name: account.name,
    url: account.url,
    urls: account.urls,
    ...(caller === 'ui' ? { username: account.username } : {}),
    usernameHint: hint,
    hasPassword: account.password.length > 0,
    hasTotp,
    totpConfigured: hasTotp,
    extraFieldKeys,
    note: account.note,
    tags: account.tags,
    displayAliases: account.displayAliases,
    expectedUin: account.expectedUin,
    appHints: account.appHints,
    loginProfile: account.loginProfile,
    manualVerificationHint: account.manualVerificationHint,
    frameAwareFill: account.frameAwareFill,
    selectors: account.selectors,
    allowedHosts: account.allowedHosts,
    envIds: account.envIds,
    pinned: account.pinned,
    useCount: account.useCount,
    lastUsedAt: account.lastUsedAt,
    deletedAt: account.deletedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

const COLUMNS = `id, name, url, urls, username, password, totp_secret, extra_fields, note, tags,
  display_aliases, expected_uin, app_hints, login_profile, manual_verification_hint,
  frame_aware_fill, selectors, allowed_hosts, env_ids, pinned, use_count, last_used_at, deleted_at,
  created_at, updated_at`;

const FIELDS = ['username', 'password'];

function text(input, key, max) {
  return raw(input, key, max).trim();
}

function raw(input, key, max) {
  const value = String((input && input[key]) || '');
  if (value.length > max) {
    throw accountError('ACCOUNT_FIELD_TOO_LONG', `${key} 不能超过 ${max} 个字符`);
  }
  return value;
}

function required(input, key, max) {
  const value = text(input, key, max);
  if (!value) throw accountError('ACCOUNT_FIELD_REQUIRED', `${key} 不能为空`);
  return value;
}

function stringArray(input, key, maxItems, maxLength) {
  if (!input || input[key] === undefined) return undefined;
  const value = input[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw accountError('ACCOUNT_FIELD_INVALID', `${key} 必须是字符串数组，最多 ${maxItems} 项`);
  }
  return JSON.stringify(
    value.map((item) => {
      const textValue = String(item || '').trim();
      if (!textValue || textValue.length > maxLength) {
        throw accountError('ACCOUNT_FIELD_INVALID', `${key} 的每项必须为 1-${maxLength} 个字符`);
      }
      return textValue;
    }),
  );
}

function normalizeExtraFieldsInput(value, key = 'extraFields') {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw accountError('ACCOUNT_FIELD_INVALID', `${key} 必须是键值对象`);
  }
  const entries = Object.entries(value);
  if (entries.length > 30) {
    throw accountError('ACCOUNT_FIELD_INVALID', `${key} 最多 30 个字段`);
  }
  const out = {};
  for (const [k, v] of entries) {
    const fieldKey = String(k || '').trim();
    if (!fieldKey || fieldKey.length > 100 || RESERVED_FIELD_KEYS.has(fieldKey)) {
      throw accountError('ACCOUNT_FIELD_INVALID', `${key} 包含非法字段名: ${fieldKey}`);
    }
    const fieldVal = v === null || v === undefined ? '' : String(v);
    if (fieldVal.length > 4096) {
      throw accountError('ACCOUNT_FIELD_TOO_LONG', `${key}.${fieldKey} 不能超过 4096 个字符`);
    }
    out[fieldKey] = fieldVal;
  }
  return JSON.stringify(out);
}

function normalizeSelectorTarget(value, key) {
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s.length > 500) {
      throw accountError('ACCOUNT_FIELD_INVALID', `selectors.${key} 必须为 1-500 字符`);
    }
    return s;
  }
  if (isPlainObject(value)) {
    const json = JSON.stringify(value);
    if (json.length > 500) {
      throw accountError('ACCOUNT_FIELD_TOO_LONG', `selectors.${key} 过大`);
    }
    return value;
  }
  throw accountError('ACCOUNT_FIELD_INVALID', `selectors.${key} 必须是选择器字符串或目标对象`);
}

function normalizeSelectorsInput(value, key = 'selectors') {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw accountError('ACCOUNT_FIELD_INVALID', `${key} 必须是对象`);
  }
  const entries = Object.entries(value);
  if (entries.length > 20) {
    throw accountError('ACCOUNT_FIELD_INVALID', `${key} 最多 20 项`);
  }
  const out = {};
  for (const [k, v] of entries) {
    const selKey = String(k || '').trim();
    if (!selKey || selKey.length > 100) {
      throw accountError('ACCOUNT_FIELD_INVALID', `${key} 键名非法`);
    }
    if (v === null || v === undefined || v === '') continue;
    out[selKey] = normalizeSelectorTarget(v, selKey);
  }
  return JSON.stringify(out);
}

function idOf(input) {
  const id = Number(input && input.id);
  if (!Number.isInteger(id) || id <= 0) throw accountError('ACCOUNT_NO_ID', '需要有效的 id');
  return id;
}

async function rowOf(host, id) {
  const rows = await host.storage.sql.query(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`, [id]);
  const row = rows[0];
  if (!row) throw accountError('ACCOUNT_NOT_FOUND', `账号 ${id} 不存在`);
  return row;
}

async function safePublishChanged(host, payload) {
  if (!host || !host.signal || typeof host.signal.publish !== 'function') return;
  try {
    await host.signal.publish('changed', payload);
  } catch {
    // 兼容最小 mock 环境
  }
}

// ---------------------------------------------------------------------------
// 纯 JS RFC 6238 TOTP（Base32 + SHA-1 / SHA-256 / SHA-512 + HMAC + otpauth://）
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map([...BASE32_ALPHABET].map((ch, idx) => [ch, idx]));

function decodeBase32(rawSecret) {
  const cleaned = String(rawSecret || '')
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
  if (!cleaned) {
    throw accountError('ACCOUNT_TOTP_INVALID', 'TOTP secret 不能为空');
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const code = BASE32_LOOKUP.get(cleaned[i]);
    if (code === undefined) {
      throw accountError('ACCOUNT_TOTP_INVALID', `TOTP secret 包含非 Base32 字符: ${cleaned[i]}`);
    }
    value = (value << 5) | code;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (!bytes.length) {
    throw accountError('ACCOUNT_TOTP_INVALID', 'TOTP secret 长度不足');
  }
  return new Uint8Array(bytes);
}

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function rotl32(x, n) {
  return (x << n) | (x >>> (32 - n));
}

function sha1(message) {
  const len = message.length;
  const padLen = (len % 64 < 56 ? 56 : 120) - (len % 64);
  const padded = new Uint8Array(len + padLen + 8);
  padded.set(message);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function sha256(message) {
  const len = message.length;
  const padLen = (len % 64 < 56 ? 56 : 120) - (len % 64);
  const padded = new Uint8Array(len + padLen + 8);
  padded.set(message);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, hs[i], false);
  return out;
}

const MASK64 = 0xffffffffffffffffn;
const SHA512_K = [
  0x428a2f98d728ae22n,
  0x7137449123ef65cdn,
  0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n,
  0x59f111f1b605d019n,
  0x923f82a4af194f9bn,
  0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n,
  0x12835b0145706fben,
  0x243185be4ee4b28cn,
  0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn,
  0x80deb1fe3b1696b1n,
  0x9bdc06a725c71235n,
  0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n,
  0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n,
  0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n,
  0x5cb0a9dcbd41fbd4n,
  0x76f988da831153b5n,
  0x983e5152ee66dfabn,
  0xa831c66d2db43210n,
  0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n,
  0xd5a79147930aa725n,
  0x06ca6351e003826fn,
  0x142929670a0e6e70n,
  0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n,
  0x4d2c6dfc5ac42aedn,
  0x53380d139d95b3dfn,
  0x650a73548baf63den,
  0x766a0abb3c77b2a8n,
  0x81c2c92e47edaee6n,
  0x92722c851482353bn,
  0xa2bfe8a14cf10364n,
  0xa81a664bbc423001n,
  0xc24b8b70d0f89791n,
  0xc76c51a30654be30n,
  0xd192e819d6ef5218n,
  0xd69906245565a910n,
  0xf40e35855771202an,
  0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n,
  0x1e376c085141ab53n,
  0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n,
  0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n,
  0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn,
  0x78a5636f43172f60n,
  0x84c87814a1f0ab72n,
  0x8cc702081a6439ecn,
  0x90befffa23631e28n,
  0xa4506cebde82bde9n,
  0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn,
  0xca273eceea26619cn,
  0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en,
  0xf57d4f7fee6ed178n,
  0x06f067aa72176fban,
  0x0a637dc5a2c898a6n,
  0x113f9804bef90daen,
  0x1b710b35131c471bn,
  0x28db77f523047d84n,
  0x32caab7b40c72493n,
  0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n,
  0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn,
  0x6c44198c4a475817n,
];

function rotr64(x, n) {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function sha512(message) {
  const len = message.length;
  const padLen = (len % 128 < 112 ? 112 : 240) - (len % 128);
  const padded = new Uint8Array(len + padLen + 16);
  padded.set(message);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLen = BigInt(len) * 8n;
  view.setBigUint64(padded.length - 16, 0n, false);
  view.setBigUint64(padded.length - 8, bitLen, false);

  let h0 = 0x6a09e667f3bcc908n;
  let h1 = 0xbb67ae8584caa73bn;
  let h2 = 0x3c6ef372fe94f82bn;
  let h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n;
  let h5 = 0x9b05688c2b3e6c1fn;
  let h6 = 0x1f83d9abfb41bd6bn;
  let h7 = 0x5be0cd19137e2179n;
  const w = Array.from({ length: 80 });

  for (let offset = 0; offset < padded.length; offset += 128) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getBigUint64(offset + i * 8, false);
    }
    for (let i = 16; i < 80; i += 1) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 80; i += 1) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & g & MASK64);
      const temp1 = (h + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & MASK64;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }
    h0 = (h0 + a) & MASK64;
    h1 = (h1 + b) & MASK64;
    h2 = (h2 + c) & MASK64;
    h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64;
    h5 = (h5 + f) & MASK64;
    h6 = (h6 + g) & MASK64;
    h7 = (h7 + h) & MASK64;
  }

  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i += 1) outView.setBigUint64(i * 8, hs[i], false);
  return out;
}

function hmac(algorithm, keyBytes, dataBytes) {
  const hashFn = algorithm === 'SHA512' ? sha512 : algorithm === 'SHA256' ? sha256 : sha1;
  const blockSize = algorithm === 'SHA512' ? 128 : 64;
  const key = keyBytes.length > blockSize ? hashFn(keyBytes) : keyBytes;
  const padded = new Uint8Array(blockSize);
  padded.set(key);

  const iKeyPad = new Uint8Array(blockSize + dataBytes.length);
  const oKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    iKeyPad[i] = padded[i] ^ 0x36;
    oKeyPad[i] = padded[i] ^ 0x5c;
  }
  iKeyPad.set(dataBytes, blockSize);
  const inner = hashFn(iKeyPad);

  const outerInput = new Uint8Array(blockSize + inner.length);
  outerInput.set(oKeyPad);
  outerInput.set(inner, blockSize);
  return hashFn(outerInput);
}

function parseTotpConfig(rawSecret) {
  const value = String(rawSecret || '').trim();
  if (!value) throw accountError('ACCOUNT_TOTP_MISSING', '未配置 TOTP');
  if (/^otpauth:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw accountError('ACCOUNT_TOTP_INVALID', 'otpauth URI 格式非法');
    }
    if (parsed.hostname.toLowerCase() !== 'totp') {
      throw accountError('ACCOUNT_TOTP_UNSUPPORTED', `仅支持 otpauth://totp，不支持 ${parsed.hostname}`);
    }
    const secret = parsed.searchParams.get('secret') || '';
    const algorithm = (parsed.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) {
      throw accountError('ACCOUNT_TOTP_INVALID', `不支持的 TOTP 算法: ${algorithm}`);
    }
    const digitsRaw = parsed.searchParams.get('digits');
    const digits = digitsRaw ? Number(digitsRaw) : 6;
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
      throw accountError('ACCOUNT_TOTP_INVALID', `digits 必须在 6-8 之间: ${digitsRaw}`);
    }
    const periodRaw = parsed.searchParams.get('period');
    const period = periodRaw ? Number(periodRaw) : 30;
    if (!Number.isInteger(period) || period < 1 || period > 300) {
      throw accountError('ACCOUNT_TOTP_INVALID', `period 必须在 1-300 秒之间: ${periodRaw}`);
    }
    return { key: decodeBase32(secret), algorithm, digits, period };
  }
  return { key: decodeBase32(value), algorithm: 'SHA1', digits: 6, period: 30 };
}

function computeTotp(rawSecret, timestampMs = Date.now()) {
  const { key, algorithm, digits, period } = parseTotpConfig(rawSecret);
  const ts = Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : Date.now();
  const nowSec = Math.floor(ts / 1000);
  const counter = BigInt(Math.floor(nowSec / period));
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, counter, false);

  const digest = hmac(algorithm, key, counterBytes);
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = String(binary % 10 ** digits).padStart(digits, '0');
  const mod = ((nowSec % period) + period) % period;
  const remainingSeconds = period - mod;
  return { code, period, remainingSeconds, digits, algorithm };
}

// ---------------------------------------------------------------------------
// 域名解析、智能站点匹配与允许域名白名单推导
// ---------------------------------------------------------------------------

function extractUrlMeta(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s) return { origin: '', host: '', hostWithPort: '', registrableDomain: '' };
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  const candidate = hasScheme ? s : `https://${s.replace(/^\.+/, '')}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { origin: '', host: '', hostWithPort: '', registrableDomain: '' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return { origin: '', host: '', hostWithPort: '', registrableDomain: '' };
  const hostWithPort = parsed.host.toLowerCase();
  const origin = hasScheme ? parsed.origin.toLowerCase() : '';
  return {
    origin,
    host,
    hostWithPort,
    registrableDomain: registrableDomainOf(host),
  };
}

function registrableDomainOf(host) {
  if (!host) return '';
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return host;
  }
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (TWO_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function hostMatchesRule(host, ruleHost) {
  if (!host || !ruleHost) return false;
  const h = host.toLowerCase();
  const d = ruleHost.toLowerCase().replace(/^\*?\./, '');
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

function extractDomainCandidate(rawItem, strictDomain) {
  const s = String(rawItem || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    return extractUrlMeta(s).host;
  }
  if (strictDomain) {
    if (/\s/.test(s)) return '';
    if (s.toLowerCase() === 'localhost') return 'localhost';
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s)) {
      return '';
    }
  }
  const cleaned = s.replace(/^\*\./, '');
  return extractUrlMeta(cleaned).host;
}

function deriveAllowedDomains(account) {
  const set = new Set();
  const add = (host) => {
    if (host) set.add(host);
  };
  add(extractDomainCandidate(account.url, false));
  for (const item of account.urls) add(extractDomainCandidate(item, false));
  for (const item of account.allowedHosts) add(extractDomainCandidate(item, false));
  for (const item of account.displayAliases) add(extractDomainCandidate(item, true));
  return [...set];
}

function scoreAccountForTarget(account, targetMeta, environmentId, query) {
  let siteScore = 0;
  const reasons = [];
  const pushReason = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  if (targetMeta.host) {
    const primary = extractUrlMeta(account.url);
    if (targetMeta.origin && primary.origin && targetMeta.origin === primary.origin) {
      siteScore = Math.max(siteScore, 120);
      pushReason('exact-origin');
    } else if (primary.hostWithPort && targetMeta.hostWithPort === primary.hostWithPort) {
      siteScore = Math.max(siteScore, 105);
      pushReason('exact-host-port');
    } else if (primary.host && targetMeta.host === primary.host) {
      siteScore = Math.max(siteScore, 95);
      pushReason('exact-host');
    }

    for (const extraUrl of account.urls) {
      const m = extractUrlMeta(extraUrl);
      if (targetMeta.origin && m.origin && targetMeta.origin === m.origin) {
        siteScore = Math.max(siteScore, 100);
        pushReason('extra-url-origin');
      } else if (m.host && m.host === targetMeta.host) {
        siteScore = Math.max(siteScore, 90);
        pushReason('extra-url-host');
      } else if (m.registrableDomain && m.registrableDomain === targetMeta.registrableDomain) {
        siteScore = Math.max(siteScore, 60);
        pushReason('same-domain');
      }
    }

    for (const allowed of account.allowedHosts) {
      const ruleHost = extractDomainCandidate(allowed, false);
      if (ruleHost && hostMatchesRule(targetMeta.host, ruleHost)) {
        siteScore = Math.max(siteScore, targetMeta.host === ruleHost ? 88 : 75);
        pushReason('allowed-host');
      }
    }

    if (primary.registrableDomain && primary.registrableDomain === targetMeta.registrableDomain) {
      siteScore = Math.max(siteScore, 60);
      pushReason('same-domain');
    }

    for (const alias of account.displayAliases) {
      const a = alias.trim().toLowerCase();
      if (!a) continue;
      const aliasHost = extractDomainCandidate(a, true);
      if (aliasHost && hostMatchesRule(targetMeta.host, aliasHost)) {
        siteScore = Math.max(siteScore, 70);
        pushReason('alias-host');
      } else if (targetMeta.host.includes(a) || a.includes(targetMeta.host)) {
        siteScore = Math.max(siteScore, 45);
        pushReason('alias-match');
      }
    }
  }

  let queryScore = 0;
  if (query) {
    const q = query.toLowerCase();
    const hay = [
      account.name,
      account.url,
      ...account.urls,
      account.username,
      account.note,
      account.tags,
      ...account.displayAliases,
      ...account.appHints,
    ]
      .join(' ')
      .toLowerCase();
    if (hay.includes(q)) {
      queryScore = 40;
      pushReason('query-match');
    }
  }

  const hasContextSignal = targetMeta.host ? siteScore > 0 : query ? queryScore > 0 : true;
  if (!hasContextSignal) {
    return { score: 0, reasons: [] };
  }

  let score = siteScore + queryScore;

  if (environmentId && account.envIds.includes(environmentId)) {
    score += 25;
    pushReason('preferred-env');
  }

  // 有站点/查询命中或无站点限制时才叠加偏好分
  if (score > 0 || (!targetMeta.host && !query)) {
    if (account.pinned) {
      score += 15;
      pushReason('pinned');
    }
    if (account.useCount > 0) {
      score += Math.min(15, account.useCount);
      pushReason('frequent');
    }
    if (account.lastUsedAt) {
      const ageDays = (Date.now() - Date.parse(account.lastUsedAt)) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= 30) {
        score += Math.max(1, Math.round(10 - ageDays / 3));
        pushReason('recent');
      }
    }
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// CRUD / 搜索 / 回收站 / 置顶 / 选择器模板
// ---------------------------------------------------------------------------

async function listAccounts(ctx, input) {
  const host = ctx.host;
  const caller = ctx.caller;
  const query = text(input, 'query', 200);
  const tag = text(input, 'tag', 100);
  const onlyDeleted = Boolean(input && input.onlyDeleted === true);
  const includeDeleted = Boolean(input && input.includeDeleted === true);
  const pinnedFirst = !(input && input.pinnedFirst === false);
  const sortBy = String((input && input.sortBy) || 'updated');

  const where = [];
  const params = [];
  if (onlyDeleted) {
    where.push("deleted_at != ''");
  } else if (!includeDeleted) {
    where.push("deleted_at = ''");
  }
  if (query) {
    const like = `%${query}%`;
    where.push(
      '(name LIKE ? OR url LIKE ? OR urls LIKE ? OR display_aliases LIKE ? OR username LIKE ? OR note LIKE ? OR tags LIKE ?)',
    );
    params.push(like, like, like, like, like, like, like);
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%${tag}%`);
  }

  const orderParts = [];
  if (pinnedFirst && !onlyDeleted) orderParts.push('pinned DESC');
  if (sortBy === 'recent') orderParts.push('last_used_at DESC, updated_at DESC, id DESC');
  else if (sortBy === 'frequent') orderParts.push('use_count DESC, last_used_at DESC, updated_at DESC, id DESC');
  else if (sortBy === 'name') orderParts.push('name COLLATE NOCASE ASC, id DESC');
  else orderParts.push('updated_at DESC, id DESC');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await host.storage.sql.query(
    `SELECT ${COLUMNS} FROM accounts ${clause} ORDER BY ${orderParts.join(', ')} LIMIT 500`,
    params,
  );
  return { accounts: rows.map((row) => toPublicAccount(host, row, caller)) };
}

async function create(ctx, input) {
  const host = ctx.host;
  const now = new Date().toISOString();
  const totpSecret = text(input, 'totpSecret', 1000);
  if (totpSecret) parseTotpConfig(totpSecret);

  const account = {
    name: required(input, 'name', 200),
    url: text(input, 'url', 2000),
    urls: stringArray(input, 'urls', 50, 2000) || '[]',
    username: text(input, 'username', 500),
    // 密码不能 trim：首尾空格也是密码的一部分
    password: raw(input, 'password', 4096),
    totp_secret: totpSecret,
    extra_fields: normalizeExtraFieldsInput(input && input.extraFields) || '{}',
    note: text(input, 'note', 20000),
    tags: text(input, 'tags', 500),
    display_aliases: stringArray(input, 'displayAliases', 50, 200) || '[]',
    expected_uin: text(input, 'expectedUin', 100),
    app_hints: stringArray(input, 'appHints', 50, 500) || '[]',
    login_profile: text(input, 'loginProfile', 100),
    manual_verification_hint: text(input, 'manualVerificationHint', 1000),
    frame_aware_fill: input && input.frameAwareFill === true ? 1 : 0,
    selectors: normalizeSelectorsInput(input && input.selectors) || '{}',
    allowed_hosts: stringArray(input, 'allowedHosts', 50, 255) || '[]',
    env_ids: stringArray(input, 'envIds', 50, 128) || '[]',
    pinned: input && input.pinned === true ? 1 : 0,
  };
  const runResult = await host.storage.sql.run(
    `INSERT INTO accounts (
       name, url, urls, username, password, totp_secret, extra_fields, note, tags,
       display_aliases, expected_uin, app_hints, login_profile, manual_verification_hint,
       frame_aware_fill, selectors, allowed_hosts, env_ids, pinned,
       use_count, last_used_at, deleted_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?)`,
    [
      account.name,
      account.url,
      account.urls,
      account.username,
      account.password,
      account.totp_secret,
      account.extra_fields,
      account.note,
      account.tags,
      account.display_aliases,
      account.expected_uin,
      account.app_hints,
      account.login_profile,
      account.manual_verification_hint,
      account.frame_aware_fill,
      account.selectors,
      account.allowed_hosts,
      account.env_ids,
      account.pinned,
      now,
      now,
    ],
  );
  const createdId = runResult && runResult.lastInsertRowid ? Number(runResult.lastInsertRowid) : undefined;
  await safePublishChanged(host, { action: 'create', ...(createdId ? { id: createdId } : {}) });
  return {
    ...(await listAccounts(ctx, input)),
    created: account.name,
    ...(createdId ? { id: createdId } : {}),
  };
}

async function update(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  await rowOf(host, id);
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
    if (!input || input[key] === undefined) continue;
    const value =
      key === 'name' ? required(input, key, max) : key === 'password' ? raw(input, key, max) : text(input, key, max);
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (input && input.totpSecret !== undefined) {
    const totpSecret = text(input, 'totpSecret', 1000);
    if (totpSecret) parseTotpConfig(totpSecret);
    sets.push('totp_secret = ?');
    params.push(totpSecret);
  }
  const columnFor = {
    urls: ['urls', stringArray(input, 'urls', 50, 2000)],
    extraFields: ['extra_fields', normalizeExtraFieldsInput(input && input.extraFields)],
    displayAliases: ['display_aliases', stringArray(input, 'displayAliases', 50, 200)],
    expectedUin: ['expected_uin', text(input, 'expectedUin', 100)],
    appHints: ['app_hints', stringArray(input, 'appHints', 50, 500)],
    loginProfile: ['login_profile', text(input, 'loginProfile', 100)],
    manualVerificationHint: ['manual_verification_hint', text(input, 'manualVerificationHint', 1000)],
    frameAwareFill: [
      'frame_aware_fill',
      input && input.frameAwareFill === undefined ? undefined : input.frameAwareFill === true ? 1 : 0,
    ],
    selectors: ['selectors', normalizeSelectorsInput(input && input.selectors)],
    allowedHosts: ['allowed_hosts', stringArray(input, 'allowedHosts', 50, 255)],
    envIds: ['env_ids', stringArray(input, 'envIds', 50, 128)],
    pinned: ['pinned', input && input.pinned === undefined ? undefined : input.pinned === true ? 1 : 0],
  };
  for (const [key, [column, value]] of Object.entries(columnFor)) {
    if (!input || input[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (!sets.length) throw accountError('ACCOUNT_NO_FIELDS', '没有要改的字段');
  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), id);
  await host.storage.sql.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  await safePublishChanged(host, { action: 'update', id });
  return listAccounts(ctx, input);
}

async function remove(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  if (input && input.soft === true) {
    return trash(ctx, input);
  }
  await host.storage.sql.run('DELETE FROM accounts WHERE id = ?', [id]);
  await safePublishChanged(host, { action: 'remove', id });
  return listAccounts(ctx, input);
}

async function trash(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  await rowOf(host, id);
  const now = new Date().toISOString();
  await host.storage.sql.run('UPDATE accounts SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
  await safePublishChanged(host, { action: 'trash', id });
  return { ...(await listAccounts(ctx, input)), trashed: id };
}

async function restore(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  await rowOf(host, id);
  const now = new Date().toISOString();
  await host.storage.sql.run("UPDATE accounts SET deleted_at = '', updated_at = ? WHERE id = ?", [now, id]);
  await safePublishChanged(host, { action: 'restore', id });
  return { ...(await listAccounts(ctx, input)), restored: id };
}

async function purge(ctx, input) {
  const host = ctx.host;
  if (input && input.all === true) {
    const res = await host.storage.sql.run("DELETE FROM accounts WHERE deleted_at != ''");
    const purgedCount = res && res.changes !== undefined ? Number(res.changes) : 0;
    await safePublishChanged(host, { action: 'purge', all: true });
    return { ...(await listAccounts(ctx, { ...input, includeDeleted: true })), purgedCount };
  }
  const id = idOf(input);
  await rowOf(host, id);
  await host.storage.sql.run('DELETE FROM accounts WHERE id = ?', [id]);
  await safePublishChanged(host, { action: 'purge', id });
  return { ...(await listAccounts(ctx, input)), purged: id };
}

async function togglePin(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  const row = await rowOf(host, id);
  const next = input && typeof input.pinned === 'boolean' ? (input.pinned ? 1 : 0) : row.pinned ? 0 : 1;
  await host.storage.sql.run('UPDATE accounts SET pinned = ?, updated_at = ? WHERE id = ?', [
    next,
    new Date().toISOString(),
    id,
  ]);
  await safePublishChanged(host, { action: 'togglePin', id, pinned: Boolean(next) });
  return { ...(await listAccounts(ctx, input)), id, pinned: Boolean(next) };
}

async function saveSelectors(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  const row = await rowOf(host, id);
  if (!input || !isPlainObject(input.selectors)) {
    throw accountError('ACCOUNT_FIELD_INVALID', 'saveSelectors 需要 selectors 对象');
  }
  const existing = input.replace === true ? {} : parseSelectors(row.selectors);
  const merged = { ...existing };
  for (const [k, v] of Object.entries(input.selectors)) {
    const key = String(k || '').trim();
    if (!key || key.length > 100) throw accountError('ACCOUNT_FIELD_INVALID', '选择器键名非法');
    if (v === null || v === undefined || v === '') {
      delete merged[key];
    } else {
      merged[key] = normalizeSelectorTarget(v, key);
    }
  }
  const serialized = normalizeSelectorsInput(merged);
  await host.storage.sql.run('UPDATE accounts SET selectors = ?, updated_at = ? WHERE id = ?', [
    serialized,
    new Date().toISOString(),
    id,
  ]);
  await safePublishChanged(host, { action: 'saveSelectors', id });
  const updatedRow = await rowOf(host, id);
  return { account: toPublicAccount(host, updatedRow, ctx.caller) };
}

async function get(ctx, input) {
  const row = await rowOf(ctx.host, idOf(input));
  return { account: toPublicAccount(ctx.host, row, ctx.caller) };
}

/** 明文导出必须由调用方显式确认（人工备份场景），避免 agent 顺手把全库打进上下文。 */
function requirePlaintextConfirm(input) {
  if (String((input && input.confirm) || '') === 'plaintext') return;
  throw accountError(
    'ACCOUNT_EXPORT_CONFIRM_REQUIRED',
    `导出明文需要 --input='{"confirm":"plaintext"}'（仅供人工备份）`,
  );
}

async function exportAccounts(ctx, input) {
  requirePlaintextConfirm(input);
  const includeDeleted = Boolean(input && input.includeDeleted === true);
  const where = includeDeleted ? '' : "WHERE deleted_at = ''";
  const rows = await ctx.host.storage.sql.query(`SELECT ${COLUMNS} FROM accounts ${where} ORDER BY id`);
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    accounts: rows.map(toAccount),
  };
}

// ---------------------------------------------------------------------------
// 智能站点匹配与页面登录字段探测
// ---------------------------------------------------------------------------

function resolveSpaceOption(ctx, input) {
  if (!input || input.space === undefined || input.space === null || input.space === '') return undefined;
  const space = String(input.space);
  if (space !== 'person' && space !== 'agent') {
    throw accountError('ACCOUNT_FIELD_INVALID', 'space 只能是 person 或 agent');
  }
  if (ctx.caller !== 'ui' && space === 'person') {
    throw accountError('SPACE_FORBIDDEN', 'agent 通道禁止操作 Person Space');
  }
  return space;
}

async function matchAccounts(ctx, input) {
  const host = ctx.host;
  const caller = ctx.caller;
  const space = resolveSpaceOption(ctx, input);
  const environmentId = String((input && input.environmentId) || ctx.environmentId || '').trim();
  const query = text(input, 'query', 200);
  const includeDeleted = Boolean(input && input.includeDeleted === true);
  const includeUnmatched = Boolean(input && input.includeUnmatched === true);
  const limitRaw = Number((input && input.limit) || 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 100)) : 20;

  let targetUrl = text(input, 'url', 2000);
  const targetHostInput = text(input, 'host', 255);
  if (!targetUrl && !targetHostInput && environmentId && host.browser && typeof host.browser.info === 'function') {
    try {
      const info = await host.browser.info(environmentId, space ? { space } : undefined);
      if (info && typeof info.url === 'string') targetUrl = info.url;
    } catch {
      // 环境未启动或无活跃标签时忽略，由后续匹配结果体现
    }
  }

  const targetMeta = extractUrlMeta(targetUrl || targetHostInput);
  const where = includeDeleted ? '' : "WHERE deleted_at = ''";
  const rows = await host.storage.sql.query(
    `SELECT ${COLUMNS} FROM accounts ${where} ORDER BY updated_at DESC, id DESC LIMIT 500`,
  );

  const scored = [];
  for (const row of rows) {
    const account = toAccount(row);
    const { score, reasons } = scoreAccountForTarget(account, targetMeta, environmentId, query);
    if (score <= 0 && !includeUnmatched) continue;
    scored.push({
      account: toPublicAccount(host, row, caller),
      score,
      reasons,
      _pinned: account.pinned ? 1 : 0,
      _useCount: account.useCount,
      _lastUsedAt: account.lastUsedAt,
      _updatedAt: account.updatedAt,
      _id: account.id,
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b._pinned - a._pinned ||
      b._useCount - a._useCount ||
      b._lastUsedAt.localeCompare(a._lastUsedAt) ||
      b._updatedAt.localeCompare(a._updatedAt) ||
      b._id - a._id,
  );

  return {
    url: targetUrl,
    host: targetMeta.host,
    matches: scored.slice(0, limit).map(({ account, score, reasons }) => ({ account, score, reasons })),
  };
}

async function detectFields(ctx, input) {
  const host = ctx.host;
  const environmentId = String((input && input.environmentId) || ctx.environmentId || '').trim();
  if (!environmentId) {
    throw accountError('ACCOUNT_NO_ENVIRONMENT', 'detectFields 需要 environmentId');
  }
  const space = resolveSpaceOption(ctx, input);
  const detected = await host.browser.detectLoginFields(environmentId, space ? { space } : undefined);
  const fields = isPlainObject(detected && detected.fields) ? detected.fields : {};
  let title = typeof (detected && detected.title) === 'string' ? detected.title : '';
  if (!title && host.browser && typeof host.browser.info === 'function') {
    try {
      const info = await host.browser.info(environmentId, space ? { space } : undefined);
      if (info && typeof info.title === 'string') title = info.title;
    } catch {
      // 忽略最小 mock 未实现 browser.info 的情况
    }
  }
  const step = String((detected && detected.step) || 'none');
  const cloneJson = (val) => (val === undefined ? undefined : JSON.parse(JSON.stringify(val)));
  const submit = fields.submit ? cloneJson(fields.submit) : null;
  const hasOtp = Boolean(fields.totp || step === 'totp-only');
  const hasCaptcha = Boolean(detected && detected.hasCaptcha);
  return {
    url: String((detected && detected.url) || ''),
    host: String((detected && detected.host) || ''),
    title,
    step,
    fields: cloneJson(fields),
    submit,
    hasOtp,
    hasCaptcha,
    ...(Array.isArray(detected && detected.candidates) ? { candidates: cloneJson(detected.candidates) } : {}),
  };
}

// ---------------------------------------------------------------------------
// fill 与 autoFill
// ---------------------------------------------------------------------------

function pickTarget(explicit, saved, detectedField) {
  if (explicit) return explicit;
  if (saved) return saved;
  if (detectedField) return detectedField.target ?? detectedField.selector;
  return undefined;
}

function buildFillOptions(ctx, input, account) {
  const space = resolveSpaceOption(ctx, input);
  const allowCrossOrigin = Boolean(input && input.allowCrossOrigin === true);
  const allowedDomains = deriveAllowedDomains(account);
  const opts = {};
  if (space) opts.space = space;
  if (ctx.caller !== 'ui' || !allowCrossOrigin) {
    if (allowedDomains.length > 0) opts.allowedDomains = allowedDomains;
  }
  return { opts, space };
}

async function fill(ctx, input) {
  const host = ctx.host;
  const id = idOf(input);
  const environmentId = String((input && input.environmentId) || ctx.environmentId || '').trim();
  if (!environmentId) {
    throw accountError('ACCOUNT_NO_ENVIRONMENT', 'fill 需要 environmentId');
  }
  const hasExplicitFields = input && input.fields !== undefined;
  const requested = (input && isPlainObject(input.fields) ? input.fields : {}) || {};
  const explicitKeys = Object.keys(requested);
  const autoDetectRequested = Boolean(input && input.autoDetect === true);

  // 兼容既有契约：显式传了空对象 fields: {} 且未要求 autoDetect 时直接报 ACCOUNT_NO_FIELDS
  if (hasExplicitFields && explicitKeys.length === 0 && !autoDetectRequested) {
    throw accountError('ACCOUNT_NO_FIELDS', 'fill 需要 fields: { username?: target, password?: target }');
  }

  const row = await rowOf(host, id);
  const account = toAccount(row);
  const { opts: fillOpts, space } = buildFillOptions(ctx, input, account);
  const submitRequested = Boolean(input && input.submit === true);
  const extraReq = isPlainObject(requested.extra) ? requested.extra : {};
  const extraSelectors = isPlainObject(account.selectors.extra) ? account.selectors.extra : {};

  // 判断是否需要调用 detectLoginFields 自动补全
  const hasUsernameTarget = Boolean(requested.username || account.selectors.username);
  const hasPasswordTarget = Boolean(requested.password || account.selectors.password);
  const hasTotpTarget = Boolean(requested.totp || account.selectors.totp);
  const hasSubmitTarget = Boolean(requested.submit || account.selectors.submit);

  const needsDetect =
    autoDetectRequested ||
    !hasExplicitFields ||
    (Boolean(account.username) && !hasUsernameTarget && explicitKeys.length > 0 && !requested.username) ||
    (Boolean(account.password) && !hasPasswordTarget && explicitKeys.length > 0 && !requested.password) ||
    (Boolean(account.totpSecret) && !hasTotpTarget) ||
    (submitRequested && !hasSubmitTarget);

  let detected;
  if (needsDetect && host.browser && typeof host.browser.detectLoginFields === 'function') {
    // 若调用方已明确给出至少一个字段且没有要求 autoDetect，探测失败不应阻断已知字段的填充
    if (!hasExplicitFields || autoDetectRequested || submitRequested) {
      detected = await host.browser.detectLoginFields(environmentId, space ? { space } : undefined);
    } else {
      try {
        detected = await host.browser.detectLoginFields(environmentId, space ? { space } : undefined);
      } catch {
        detected = undefined;
      }
    }
  }
  const detectedFields = (detected && isPlainObject(detected.fields) ? detected.fields : {}) || {};
  const detectedStep = detected && typeof detected.step === 'string' ? detected.step : '';
  const allowAutoField = (kind) => {
    if (!detectedStep || detectedStep === 'single' || detectedStep === 'none') return true;
    if (detectedStep === 'username-only') return kind === 'username';
    if (detectedStep === 'password-only') return kind === 'password';
    if (detectedStep === 'totp-only') return kind === 'totp';
    return true;
  };

  const filled = [];
  const fillOne = async (fieldName, target, value, isExplicitRequest) => {
    if (!target) return;
    if (!value) {
      if (isExplicitRequest) {
        throw accountError('ACCOUNT_FIELD_MISSING', `账号 ${id} 没有 ${fieldName}`);
      }
      return;
    }
    if (Object.keys(fillOpts).length > 0) {
      await host.browser.fillSecret(environmentId, target, value, fillOpts);
    } else {
      await host.browser.fillSecret(environmentId, target, value);
    }
    filled.push(fieldName);
  };

  // 1. username & password
  for (const field of FIELDS) {
    const explicitTarget = requested[field];
    const target =
      explicitTarget ||
      (allowAutoField(field) ? pickTarget(undefined, account.selectors[field], detectedFields[field]) : undefined);
    await fillOne(field, target, account[field], Boolean(explicitTarget));
  }

  // 2. extraFields（从 fields.<key> / fields.extra.<key> / selectors.<key> / selectors.extra.<key> 解析）
  for (const [extraKey, extraVal] of Object.entries(account.extraFields)) {
    if (RESERVED_FIELD_KEYS.has(extraKey)) continue;
    const explicitTarget = requested[extraKey] ?? requested[`extra:${extraKey}`] ?? extraReq[extraKey];
    const savedTarget = allowAutoField('extra')
      ? (account.selectors[extraKey] ?? account.selectors[`extra:${extraKey}`] ?? extraSelectors[extraKey])
      : undefined;
    const target = explicitTarget || savedTarget;
    if (!target) continue;
    await fillOne(extraKey, target, extraVal, Boolean(explicitTarget));
  }

  // 3. totp
  const explicitTotpTarget = requested.totp;
  const totpTarget =
    explicitTotpTarget ||
    (allowAutoField('totp') ? pickTarget(undefined, account.selectors.totp, detectedFields.totp) : undefined);
  if (totpTarget) {
    if (!account.totpSecret) {
      if (explicitTotpTarget) {
        throw accountError('ACCOUNT_FIELD_MISSING', `账号 ${id} 没有 totpSecret`);
      }
    } else {
      const { code } = computeTotp(account.totpSecret, Date.now());
      await fillOne('totp', totpTarget, code, Boolean(explicitTotpTarget));
    }
  }

  if (!filled.length) {
    throw accountError('ACCOUNT_NO_FIELDS', 'fill 需要 fields: { username?: target, password?: target }');
  }

  // 4. 可选 submit
  let submitted;
  if (submitRequested) {
    const submitTarget = pickTarget(requested.submit, account.selectors.submit, detectedFields.submit);
    if (submitTarget && host.browser && typeof host.browser.click === 'function') {
      const clickOpts = {
        environmentId,
        ...(space ? { space } : {}),
        ...(input && input.noWaitAfter !== undefined ? { noWaitAfter: Boolean(input.noWaitAfter) } : {}),
      };
      await host.browser.click(submitTarget, clickOpts);
      submitted = true;
    } else {
      submitted = false;
    }
  }

  // 5. 更新使用计数与最近使用时间并广播信号
  const now = new Date().toISOString();
  await host.storage.sql.run('UPDATE accounts SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', [now, id]);
  await safePublishChanged(host, { action: 'fill', id });

  return {
    filled,
    id,
    ...(submitted !== undefined ? { submitted } : {}),
    ...(detected && detected.step ? { step: String(detected.step) } : {}),
    ...(account.manualVerificationHint ? { manualVerificationHint: account.manualVerificationHint } : {}),
  };
}

async function autoFill(ctx, input) {
  const environmentId = String((input && input.environmentId) || ctx.environmentId || '').trim();
  if (!environmentId) {
    throw accountError('ACCOUNT_NO_ENVIRONMENT', 'autoFill 需要 environmentId');
  }
  const space = resolveSpaceOption(ctx, input);
  let targetId = input && input.id !== undefined ? idOf(input) : undefined;
  let matchedSummary;

  if (!targetId) {
    const matchRes = await matchAccounts(ctx, { environmentId, space, limit: 10 });
    const matches = matchRes.matches;
    if (!matches.length) {
      throw accountError(
        'ACCOUNT_NO_MATCH',
        `当前页面（${matchRes.host || matchRes.url || environmentId}）没有匹配的账号`,
      );
    }
    const top = matches[0];
    const pickBest = Boolean(input && input.pickBest === true);
    if (!pickBest && matches.length > 1) {
      const competing = matches.filter((m) => m.score >= Math.max(60, top.score - 30));
      if (competing.length > 1) {
        const desc = competing
          .slice(0, 5)
          .map((m) => `id=${m.account.id}(${m.account.name}, ${m.account.usernameHint || '-'})`)
          .join(', ');
        throw accountError('ACCOUNT_AMBIGUOUS', `当前页面匹配到多个候选账号，请指定 id 或传 pickBest=true：${desc}`, {
          candidates: competing.map((m) => ({
            id: m.account.id,
            name: m.account.name,
            usernameHint: m.account.usernameHint,
            score: m.score,
          })),
        });
      }
    }
    targetId = top.account.id;
    matchedSummary = {
      matchedAccount: top.account,
      matchScore: top.score,
    };
  }

  const fillResult = await fill(ctx, {
    ...input,
    id: targetId,
    environmentId,
    autoDetect: true,
  });
  return {
    ...fillResult,
    ...matchedSummary,
  };
}

// ---------------------------------------------------------------------------
// 明文揭示（仅 UI）与 TOTP 动态码（仅 UI）
// ---------------------------------------------------------------------------

async function reveal(ctx, input) {
  if (ctx.caller !== 'ui') {
    throw accountError('ACCOUNT_REVEAL_UI_ONLY', 'reveal 只对插件界面开放；agent 通道请用 fill');
  }
  const id = idOf(input);
  const field = String((input && input.field) || 'password');
  const row = await rowOf(ctx.host, id);
  const account = toAccount(row);

  if (field === 'password' || field === 'username' || field === 'totpSecret') {
    return { id, field, value: account[field] };
  }
  if (field.startsWith('extra:')) {
    const extraKey = field.slice(6);
    if (!extraKey || !Object.prototype.hasOwnProperty.call(account.extraFields, extraKey)) {
      throw accountError('ACCOUNT_FIELD_UNKNOWN', `账号 ${id} 没有扩展字段 ${extraKey || '(空)'}`);
    }
    return { id, field, value: account.extraFields[extraKey] };
  }
  throw accountError('ACCOUNT_FIELD_UNKNOWN', `reveal 只支持 username / password / totpSecret / extra:<key>`);
}

async function totpCode(ctx, input) {
  if (ctx.caller !== 'ui') {
    throw accountError('ACCOUNT_TOTP_UI_ONLY', 'totpCode 只对插件界面开放；agent 通道请用 fill / autoFill 自动填入');
  }
  const id = idOf(input);
  const row = await rowOf(ctx.host, id);
  const secret = String(row.totp_secret ?? '');
  if (!secret) {
    throw accountError('ACCOUNT_TOTP_MISSING', `账号 ${id} 未配置 TOTP`);
  }
  const timestampMs = input && input.timestampMs !== undefined ? Number(input.timestampMs) : Date.now();
  const computed = computeTotp(secret, timestampMs);
  return { id, ...computed };
}

// ---------------------------------------------------------------------------
// 密码生成器与批量导入
// ---------------------------------------------------------------------------

function randomInt(max) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

function generatePassword(input) {
  const opts = input || {};
  const length = opts.length === undefined ? 20 : Number(opts.length);
  if (!Number.isInteger(length) || length < 8 || length > 128) {
    throw accountError('ACCOUNT_FIELD_INVALID', '密码长度 length 必须为 8-128 之间的整数');
  }
  const excludeAmbiguous = Boolean(opts.excludeAmbiguous === true);
  const sets = [];
  const enabledNames = [];
  if (opts.uppercase !== false) {
    sets.push(excludeAmbiguous ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    enabledNames.push('uppercase');
  }
  if (opts.lowercase !== false) {
    sets.push(excludeAmbiguous ? 'abcdefghijkmnopqrstuvwxyz' : 'abcdefghijklmnopqrstuvwxyz');
    enabledNames.push('lowercase');
  }
  if (opts.numbers !== false) {
    sets.push(excludeAmbiguous ? '23456789' : '0123456789');
    enabledNames.push('numbers');
  }
  if (opts.symbols !== false) {
    sets.push('!@#$%^&*()-_=+[]{}:,.?');
    enabledNames.push('symbols');
  }
  if (!sets.length) {
    throw accountError('ACCOUNT_FIELD_INVALID', '至少启用一种字符集（uppercase/lowercase/numbers/symbols）');
  }

  const combined = sets.join('');
  const chars = [];
  for (const s of sets) {
    chars.push(s[randomInt(s.length)]);
  }
  while (chars.length < length) {
    chars.push(combined[randomInt(combined.length)]);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return {
    password: chars.join(''),
    length,
    sets: enabledNames,
  };
}

function parseCsvRows(textContent) {
  const src = String(textContent || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((v) => v.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((v) => v.length > 0)) rows.push(row);
  }
  return rows;
}

function parseImportItems(format, content) {
  let effectiveFormat = format;
  if (effectiveFormat === 'auto') {
    if (typeof content === 'object' && content !== null) {
      effectiveFormat = 'json';
    } else {
      const trimmed = String(content || '').trim();
      effectiveFormat = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'csv';
    }
  }

  if (effectiveFormat === 'json') {
    const data = typeof content === 'string' ? JSON.parse(content) : content;
    const list = Array.isArray(data) ? data : data && Array.isArray(data.accounts) ? data.accounts : null;
    if (!list) throw accountError('ACCOUNT_IMPORT_INVALID', 'JSON 导入内容必须是数组或包含 accounts 数组');
    return list;
  }

  const rows = parseCsvRows(String(content || ''));
  if (rows.length < 2) {
    throw accountError('ACCOUNT_IMPORT_INVALID', 'CSV 至少需要表头行和一行数据');
  }
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const mapCol = (aliases) => headers.findIndex((h) => aliases.includes(h));
  const idx = {
    name: mapCol(['name', 'title', 'site']),
    url: mapCol(['url', 'origin', 'website']),
    username: mapCol(['username', 'user', 'login', 'email']),
    password: mapCol(['password', 'pass']),
    note: mapCol(['note', 'notes', 'comment']),
    tags: mapCol(['tags', 'tag']),
    totpSecret: mapCol(['totp', 'totp_secret', 'totpsecret', 'otp']),
  };

  return rows.slice(1).map((cols) => {
    const getCol = (pos) => (pos >= 0 && pos < cols.length ? cols[pos] : '');
    const url = getCol(idx.url).trim();
    const rawName = getCol(idx.name).trim();
    const hostFallback = extractUrlMeta(url).host;
    return {
      name: rawName || hostFallback,
      url,
      username: getCol(idx.username).trim(),
      password: getCol(idx.password),
      note: getCol(idx.note).trim(),
      tags: getCol(idx.tags).trim(),
      totpSecret: getCol(idx.totpSecret).trim(),
    };
  });
}

function dedupeKeyFor(item) {
  const host = extractUrlMeta(item.url).host;
  const primary =
    host ||
    String(item.name || '')
      .trim()
      .toLowerCase();
  const user = String(item.username || '')
    .trim()
    .toLowerCase();
  return `${primary}\0${user}`;
}

async function importAccounts(ctx, input) {
  const host = ctx.host;
  const format = String((input && input.format) || 'auto');
  const strategy = String((input && input.strategy) || 'skip');
  if (!['auto', 'json', 'csv', 'chrome-csv'].includes(format)) {
    throw accountError('ACCOUNT_FIELD_INVALID', `不支持的导入格式: ${format}`);
  }
  if (!['skip', 'overwrite', 'duplicate'].includes(strategy)) {
    throw accountError('ACCOUNT_FIELD_INVALID', `不支持的去重策略: ${strategy}`);
  }
  if (!input || input.content === undefined || input.content === null || input.content === '') {
    throw accountError('ACCOUNT_IMPORT_INVALID', 'importAccounts 需要 content');
  }

  let items;
  try {
    items = parseImportItems(format, input.content);
  } catch (err) {
    if (err && err.code) throw err;
    throw accountError('ACCOUNT_IMPORT_INVALID', `解析导入内容失败: ${err && err.message ? err.message : String(err)}`);
  }

  const existingRows = await host.storage.sql.query(
    `SELECT ${COLUMNS} FROM accounts WHERE deleted_at = '' ORDER BY id`,
  );
  const existingMap = new Map();
  for (const row of existingRows) {
    existingMap.set(dedupeKeyFor(row), Number(row.id));
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < items.length; i += 1) {
    const rawItem = items[i];
    if (!isPlainObject(rawItem)) {
      failed += 1;
      errors.push({ index: i, message: '记录不是对象' });
      continue;
    }
    const fallbackName = extractUrlMeta(rawItem.url).host;
    const item = {
      ...rawItem,
      name: String(rawItem.name || fallbackName || '').trim(),
    };
    if (!item.name) {
      failed += 1;
      errors.push({ index: i, message: '缺少 name 且无法从 url 推导站点名' });
      continue;
    }
    const key = dedupeKeyFor(item);
    const existingId = existingMap.get(key);
    try {
      if (existingId && strategy === 'skip') {
        skipped += 1;
        continue;
      }
      if (existingId && strategy === 'overwrite') {
        const now = new Date().toISOString();
        const totpSecret = text(item, 'totpSecret', 1000);
        if (totpSecret) parseTotpConfig(totpSecret);
        await host.storage.sql.run(
          `UPDATE accounts SET
             name = ?, url = ?, urls = ?, username = ?, password = ?, totp_secret = ?, extra_fields = ?,
             note = ?, tags = ?, display_aliases = ?, expected_uin = ?, app_hints = ?,
             login_profile = ?, manual_verification_hint = ?, frame_aware_fill = ?,
             selectors = ?, allowed_hosts = ?, env_ids = ?, pinned = ?, updated_at = ?
           WHERE id = ?`,
          [
            required(item, 'name', 200),
            text(item, 'url', 2000),
            stringArray(item, 'urls', 50, 2000) || '[]',
            text(item, 'username', 500),
            raw(item, 'password', 4096),
            totpSecret,
            normalizeExtraFieldsInput(item.extraFields) || '{}',
            text(item, 'note', 20000),
            text(item, 'tags', 500),
            stringArray(item, 'displayAliases', 50, 200) || '[]',
            text(item, 'expectedUin', 100),
            stringArray(item, 'appHints', 50, 500) || '[]',
            text(item, 'loginProfile', 100),
            text(item, 'manualVerificationHint', 1000),
            item.frameAwareFill === true ? 1 : 0,
            normalizeSelectorsInput(item.selectors) || '{}',
            stringArray(item, 'allowedHosts', 50, 255) || '[]',
            stringArray(item, 'envIds', 50, 128) || '[]',
            item.pinned === true ? 1 : 0,
            now,
            existingId,
          ],
        );
        updated += 1;
        continue;
      }

      const now = new Date().toISOString();
      const totpSecret = text(item, 'totpSecret', 1000);
      if (totpSecret) parseTotpConfig(totpSecret);
      const runResult = await host.storage.sql.run(
        `INSERT INTO accounts (
           name, url, urls, username, password, totp_secret, extra_fields, note, tags,
           display_aliases, expected_uin, app_hints, login_profile, manual_verification_hint,
           frame_aware_fill, selectors, allowed_hosts, env_ids, pinned,
           use_count, last_used_at, deleted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?)`,
        [
          required(item, 'name', 200),
          text(item, 'url', 2000),
          stringArray(item, 'urls', 50, 2000) || '[]',
          text(item, 'username', 500),
          raw(item, 'password', 4096),
          totpSecret,
          normalizeExtraFieldsInput(item.extraFields) || '{}',
          text(item, 'note', 20000),
          text(item, 'tags', 500),
          stringArray(item, 'displayAliases', 50, 200) || '[]',
          text(item, 'expectedUin', 100),
          stringArray(item, 'appHints', 50, 500) || '[]',
          text(item, 'loginProfile', 100),
          text(item, 'manualVerificationHint', 1000),
          item.frameAwareFill === true ? 1 : 0,
          normalizeSelectorsInput(item.selectors) || '{}',
          stringArray(item, 'allowedHosts', 50, 255) || '[]',
          stringArray(item, 'envIds', 50, 128) || '[]',
          item.pinned === true ? 1 : 0,
          now,
          now,
        ],
      );
      if (strategy !== 'duplicate' && runResult && runResult.lastInsertRowid) {
        existingMap.set(key, Number(runResult.lastInsertRowid));
      }
      imported += 1;
    } catch (err) {
      failed += 1;
      errors.push({
        index: i,
        name: item.name,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  if (imported > 0 || updated > 0) {
    await safePublishChanged(host, { action: 'import', imported, updated });
  }
  return { imported, updated, skipped, failed, errors };
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
      ['totp_secret', "TEXT NOT NULL DEFAULT ''"],
      ['urls', "TEXT NOT NULL DEFAULT '[]'"],
      ['extra_fields', "TEXT NOT NULL DEFAULT '{}'"],
      ['selectors', "TEXT NOT NULL DEFAULT '{}'"],
      ['allowed_hosts', "TEXT NOT NULL DEFAULT '[]'"],
      ['env_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
      ['use_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_used_at', "TEXT NOT NULL DEFAULT ''"],
      ['deleted_at', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!present.has(name)) {
        await ctx.host.storage.sql.run(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
      }
    }
    await ctx.host.log.info('账号库已就绪（明文存储）');
  },

  list(ctx) {
    return listAccounts(ctx, ctx.input);
  },
  create(ctx) {
    return create(ctx, ctx.input);
  },
  update(ctx) {
    return update(ctx, ctx.input);
  },
  remove(ctx) {
    return remove(ctx, ctx.input);
  },
  trash(ctx) {
    return trash(ctx, ctx.input);
  },
  restore(ctx) {
    return restore(ctx, ctx.input);
  },
  purge(ctx) {
    return purge(ctx, ctx.input);
  },
  match(ctx) {
    return matchAccounts(ctx, ctx.input);
  },
  detectFields(ctx) {
    return detectFields(ctx, ctx.input);
  },
  fill(ctx) {
    return fill(ctx, ctx.input);
  },
  autoFill(ctx) {
    return autoFill(ctx, ctx.input);
  },
  togglePin(ctx) {
    return togglePin(ctx, ctx.input);
  },
  saveSelectors(ctx) {
    return saveSelectors(ctx, ctx.input);
  },
  generatePassword(ctx) {
    return generatePassword(ctx.input);
  },
  importAccounts(ctx) {
    return importAccounts(ctx, ctx.input);
  },
  export(ctx) {
    return exportAccounts(ctx, ctx.input);
  },

  rpc: {
    list(input, ctx) {
      return listAccounts(ctx, input);
    },
    get(input, ctx) {
      return get(ctx, input);
    },
    create(input, ctx) {
      return create(ctx, input);
    },
    update(input, ctx) {
      return update(ctx, input);
    },
    remove(input, ctx) {
      return remove(ctx, input);
    },
    trash(input, ctx) {
      return trash(ctx, input);
    },
    restore(input, ctx) {
      return restore(ctx, input);
    },
    purge(input, ctx) {
      return purge(ctx, input);
    },
    match(input, ctx) {
      return matchAccounts(ctx, input);
    },
    detectFields(input, ctx) {
      return detectFields(ctx, input);
    },
    fill(input, ctx) {
      return fill(ctx, input);
    },
    autoFill(input, ctx) {
      return autoFill(ctx, input);
    },
    togglePin(input, ctx) {
      return togglePin(ctx, input);
    },
    saveSelectors(input, ctx) {
      return saveSelectors(ctx, input);
    },
    generatePassword(input) {
      return generatePassword(input);
    },
    importAccounts(input, ctx) {
      return importAccounts(ctx, input);
    },
    reveal(input, ctx) {
      return reveal(ctx, input);
    },
    totpCode(input, ctx) {
      return totpCode(ctx, input);
    },
    export(input, ctx) {
      return exportAccounts(ctx, input);
    },
  },
};
