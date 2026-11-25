/**
 * 下载落盘接线。
 *
 * 每个 session 只挂**一次** `will-download`（session 跨环境重启复用，重复挂会互相覆盖），
 * 但队列要**每次事件发生时现取**——否则环境停一次再启动，监听器还写着上一个
 * pending，新下载谁也读不到（saveAs 报「未知下载」、waitForEvent 超时）。
 */
import type { Session } from 'electron';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEnvKey } from '../domain/environment.ts';
import { sanitizeFilename } from './policy.ts';
import type { EnvPending } from './pending.ts';

/** 已经挂过 `will-download` 的 session。 */
const wired = new WeakSet<Session>();

export function wireDownloads(
  ses: Session,
  environmentId: string,
  pendingFor: (environmentId: string) => EnvPending | undefined,
  record: (type: string, message: string) => void,
): void {
  if (wired.has(ses)) return;
  wired.add(ses);
  ses.on('will-download', (_event, item) => {
    try {
      const pending = pendingFor(environmentId);
      if (!pending) return; // 环境已停：临时区随后会被清掉，不登记
      const downloadId = crypto.randomUUID();
      const filename = sanitizeFilename(item.getFilename());
      const dir = path.join(os.tmpdir(), 'warren-downloads', safeEnvKey(environmentId));
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${downloadId}-${filename}`);
      item.setSavePath(target);
      const url = item.getURL();
      pending.noteDownload(
        { downloadId, url, filename, at: new Date().toISOString() },
        { item, url, filename, path: target },
      );
      record('browser.download', `${environmentId} 下载 ${filename}`);
    } catch {
      // 下载登记失败不能影响页面本身
    }
  });
}
