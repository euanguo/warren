import { safeStorage } from 'electron';
import type { Encryptor } from './store';

/**
 * Electron safeStorage 支持的加密器。
 * - macOS: 密钥存 Keychain；生产构建必须稳定签名，否则每次更新都会弹密码框
 * - 用异步 API（官方推荐：非阻塞、支持密钥轮换、临时不可用时可优雅处理）
 */
export class SafeStorageEncryptor implements Encryptor {
  #ready = false;

  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    this.#ready = true;
    return true;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** 同步版本仅用于持久化路径；加解密一律走异步 */
  encrypt(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64');
  }

  decrypt(cipher: string): string {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  }

  async encryptAsync(plain: string): Promise<string> {
    const buffer = await safeStorage.encryptStringAsync(plain);
    return buffer.toString('base64');
  }

  async decryptAsync(cipher: string): Promise<string> {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(cipher, 'base64'));
    if (shouldReEncrypt) this.#needsReEncrypt = true;
    return result;
  }

  #needsReEncrypt = false;

  get needsReEncrypt(): boolean {
    return this.#needsReEncrypt;
  }
}
