/**
 * 浏览器层统一 Promise 超时保护，超时返回规范 `TIMEOUT` RichError 并保证清理定时器。
 */
import { richErr } from './errors.ts';

export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(richErr('TIMEOUT', message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
