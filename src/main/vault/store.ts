export interface Encryptor {
  /** 返回 base64 密文 */
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  available(): boolean;
}

export interface CredentialSecret {
  username?: string;
  password?: string;
  token?: string;
  totp?: string;
}

export const ALLOWED_SECRET_FIELDS = ['username', 'password', 'token', 'totp'] as const;
export type SecretField = (typeof ALLOWED_SECRET_FIELDS)[number];

export function isSecretField(value: unknown): value is SecretField {
  return typeof value === 'string' && (ALLOWED_SECRET_FIELDS as readonly string[]).includes(value);
}

/** 校验并清洗 Vault secret 负载：仅保留白名单字符串字段，拒绝数组与原型污染键。 */
export function sanitizeCredentialSecret(raw: unknown): CredentialSecret {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('BAD_REQUEST', 'secret must be a plain object');
  }
  const input = raw as Record<string, unknown>;
  const secret: CredentialSecret = {};
  for (const key of ALLOWED_SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const val = input[key];
    if (val === undefined) continue;
    if (typeof val !== 'string') {
      fail('BAD_REQUEST', `secret.${key} must be a string`);
    }
    const normalized = key === 'password' ? val : val.trim();
    if (normalized) secret[key] = normalized;
  }
  if (Object.keys(secret).length === 0) fail('BAD_REQUEST', 'secret is empty');
  return secret;
}

export interface CredentialRecord {
  ref: string;
  id: string;
  provider: string;
  label: string;
  usernameHint: string;
  cipher: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSummary {
  ref: string;
  provider: string;
  label: string;
  usernameHint: string;
  /**
   * 这条凭据现在还能不能解开。
   *
   * 旧密钥写的记录（应用改名 / 重装 / 换机器后 Keychain 密钥变了）永远解不开，
   * 但 `list()` 照样列得出来——不标出来，人和 agent 会一直拿一条废凭据去填，
   * 报的还是「cannot decrypt」这种看不出所以然的错。
   */
  available: boolean;
  createdAt: string;
  updatedAt: string;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** 只保留首字符和域名，避免列表泄露完整账号 */
export function maskHint(username?: string): string {
  if (!username) return '';
  const [local, domain] = username.split('@');
  if (domain) return `${local.slice(0, 1)}***@${domain}`;
  return `${username.slice(0, 1)}***`;
}

export class VaultStore {
  #records: CredentialRecord[] = [];
  #encryptor: Encryptor;
  #now: () => string;

  constructor(encryptor: Encryptor, options: { now?: () => string } = {}) {
    this.#encryptor = encryptor;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get available(): boolean {
    return this.#encryptor.available();
  }

  list(): CredentialSummary[] {
    return this.#records.map((record) => ({
      ref: record.ref,
      provider: record.provider,
      label: record.label,
      usernameHint: record.usernameHint,
      available: this.#usable(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  /** 只判「能不能解开」，不返回明文。密钥库不可用时一律算不可用。 */
  #usable(record: CredentialRecord): boolean {
    if (!this.#encryptor.available()) return false;
    try {
      this.#encryptor.decrypt(record.cipher);
      return true;
    } catch {
      return false;
    }
  }

  add(input: { provider: string; label: string; secret: CredentialSecret }): CredentialSummary {
    if (!this.#encryptor.available()) fail('VAULT_UNAVAILABLE', '系统密钥存储不可用');
    const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
    if (!provider) fail('BAD_REQUEST', 'provider is required');
    const cleanSecret = sanitizeCredentialSecret(input.secret);
    const label = typeof input.label === 'string' ? input.label.trim() : '';

    const id = crypto.randomUUID();
    const now = this.#now();
    const record: CredentialRecord = {
      ref: `vault://${id}`,
      id,
      provider,
      label: label || provider,
      usernameHint: maskHint(cleanSecret.username),
      cipher: this.#encryptor.encrypt(JSON.stringify(cleanSecret)),
      createdAt: now,
      updatedAt: now,
    };
    this.#records.push(record);
    const { cipher: _cipher, id: _id, ...summary } = record;
    // 刚写进去的必然解得开
    return { ...summary, available: true };
  }

  remove(ref: string): boolean {
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => record.ref !== ref);
    return this.#records.length !== before;
  }

  has(ref: string): boolean {
    return this.#records.some((record) => record.ref === ref);
  }

  /**
   * 只有 Core 内部可以调用。
   * 绝不能经 RPC / IPC / 插件 API 暴露出去——那样等于把密码交给调用方。
   */
  reveal(ref: string): CredentialSecret {
    const record = this.#records.find((item) => item.ref === ref);
    if (!record) fail('CREDENTIAL_NOT_FOUND', `unknown credential ${ref}`);
    try {
      return JSON.parse(this.#encryptor.decrypt(record.cipher)) as CredentialSecret;
    } catch {
      fail(
        'VAULT_DECRYPT_FAILED',
        `cannot decrypt ${ref}：这条凭据是用旧密钥加密的（应用改名 / 重装 / 换机器后 Keychain 密钥会变），` +
          `已经解不开了。删掉它重新添加：warren vault remove ${ref}`,
      );
    }
  }

  /** 持久化用。cipher 已经是密文，落盘不出现明文。 */
  serialize(): CredentialRecord[] {
    return this.#records;
  }

  load(records: CredentialRecord[]): void {
    this.#records = Array.isArray(records) ? records : [];
  }
}
