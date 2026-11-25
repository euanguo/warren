import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultStore, maskHint, type Encryptor } from '../src/main/vault/store.ts';

/** 测试用可逆加密：只验证流程，不验证密码学 */
function fakeEncryptor(available = true): Encryptor {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
    // 解不开就抛（真 encryptor 换了密钥就是这个行为），别悄悄返回乱码
    decrypt: (cipher) => {
      const text = Buffer.from(cipher, 'base64').toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad key');
      return text.slice(4);
    },
  };
}

test('vault stores credentials and never serializes the plaintext', () => {
  const vault = new VaultStore(fakeEncryptor(), { now: () => '2026-01-01T00:00:00.000Z' });
  const summary = vault.add({
    provider: 'github',
    label: 'personal',
    secret: { username: 'verger@example.com', password: 'hunter2-super-secret' },
  });

  assert.match(summary.ref, /^vault:\/\/[0-9a-f-]{36}$/);
  assert.equal(summary.usernameHint, 'v***@example.com');

  const onDisk = JSON.stringify(vault.serialize());
  assert.ok(!onDisk.includes('hunter2-super-secret'), '明文密码不能出现在持久化数据里');

  assert.equal(vault.reveal(summary.ref).password, 'hunter2-super-secret');
});

test('vault list exposes no secret material', () => {
  const vault = new VaultStore(fakeEncryptor());
  vault.add({
    provider: 'github',
    label: 'personal',
    secret: { username: 'a@b.com', token: 'ghp_secret' },
  });

  const listed = vault.list();
  assert.equal(listed.length, 1);
  const shape = JSON.stringify(listed);
  assert.ok(!shape.includes('ghp_secret'));
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    'available',
    'createdAt',
    'label',
    'provider',
    'ref',
    'updatedAt',
    'usernameHint',
  ]);
  assert.equal(listed[0].available, true);
});

test('解不开的凭据（旧密钥）在 list 里标成不可用，reveal 给出下一步', () => {
  const vault = new VaultStore(fakeEncryptor());
  vault.add({ provider: 'example', label: '旧', secret: { password: 'p' } });
  // 模拟「应用改名 / 重装 / 换机器」后密文解不开：直接塞一条坏 cipher
  vault.load([{ ...vault.serialize()[0]!, cipher: Buffer.from('旧密钥的密文').toString('base64') }]);

  const listed = vault.list();
  assert.equal(listed.length, 1, '解不开也要列出来，人才知道该删');
  assert.equal(listed[0].available, false);
  assert.throws(
    () => vault.reveal(listed[0].ref),
    (error: Error & { code?: string }) => error.code === 'VAULT_DECRYPT_FAILED' && /vault remove/.test(error.message),
  );
});

test('vault refuses to store when system key storage is unavailable', () => {
  const vault = new VaultStore(fakeEncryptor(false));
  assert.equal(vault.available, false);
  assert.throws(() => vault.add({ provider: 'x', label: 'x', secret: { password: 'p' } }), /系统密钥存储不可用/);
});

test('vault remove and unknown ref behave predictably', () => {
  const vault = new VaultStore(fakeEncryptor());
  const { ref } = vault.add({ provider: 'github', label: 'l', secret: { password: 'p' } });
  assert.equal(vault.has(ref), true);
  assert.equal(vault.remove(ref), true);
  assert.equal(vault.has(ref), false);
  assert.equal(vault.remove(ref), false);
  assert.throws(() => vault.reveal(ref), /unknown credential/);
});

test('maskHint keeps only the first character and the domain', () => {
  assert.equal(maskHint('verger@example.com'), 'v***@example.com');
  assert.equal(maskHint('token-only'), 't***');
  assert.equal(maskHint(undefined), '');
});
