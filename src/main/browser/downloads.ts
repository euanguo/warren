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
import type { DownloadItemInfo } from '../../shared/types.ts';
import { safeEnvKey } from '../domain/environment.ts';
import { sanitizeFilename } from './policy.ts';
import type { EnvPending } from './pending.ts';

const DOWNLOAD_HISTORY_LIMIT = 200;

/** 已经挂过 `will-download` 的 session。 */
const wired = new WeakSet<Session>();

/** 最近下载历史（供 UI 下载浮卡展示与 Finder 定位）。 */
const history: DownloadItemInfo[] = [];
const historyById = new Map<string, DownloadItemInfo>();

function recordDownloadInfo(info: DownloadItemInfo): void {
  historyById.set(info.downloadId, info);
  const idx = history.findIndex((item) => item.downloadId === info.downloadId);
  if (idx >= 0) history[idx] = info;
  else {
    history.unshift(info);
    if (history.length > DOWNLOAD_HISTORY_LIMIT) {
      const removed = history.pop();
      if (removed) historyById.delete(removed.downloadId);
    }
  }
}

export function listDownloads(envId?: string): DownloadItemInfo[] {
  const list = envId ? history.filter((item) => item.envId === envId) : history;
  return list.map((item) => ({ ...item }));
}

export function getDownloadPath(downloadId: string): string | undefined {
  return historyById.get(downloadId)?.savePath;
}

/** 清理指定环境（或全部）的下载历史条目，防止环境删除后残留索引与内存增长。 */
export function clearDownloads(envId?: string): void {
  if (!envId) {
    history.length = 0;
    historyById.clear();
    return;
  }
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item && item.envId === envId) {
      historyById.delete(item.downloadId);
      history.splice(i, 1);
    }
  }
}

export function wireDownloads(
  ses: Session,
  environmentId: string,
  pendingFor: (environmentId: string) => EnvPending | undefined,
  record: (type: string, message: string) => void,
  onChanged?: () => void,
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
      const at = new Date().toISOString();
      pending.noteDownload({ downloadId, url, filename, at }, { item, url, filename, path: target });

      const info: DownloadItemInfo = {
        downloadId,
        envId: environmentId,
        filename,
        url,
        savePath: target,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        startedAt: at,
      };
      recordDownloadInfo(info);
      onChanged?.();

      item.on('updated', (_e, state) => {
        const cur = historyById.get(downloadId);
        if (!cur) return;
        cur.receivedBytes = item.getReceivedBytes();
        cur.totalBytes = item.getTotalBytes();
        cur.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        cur.savePath = item.getSavePath() || cur.savePath;
        onChanged?.();
      });

      item.once('done', (_e, state) => {
        const cur = historyById.get(downloadId);
        if (!cur) return;
        cur.receivedBytes = item.getReceivedBytes();
        cur.totalBytes = item.getTotalBytes();
        cur.savePath = item.getSavePath() || cur.savePath;
        cur.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
        onChanged?.();
      });

      record('browser.download', `${environmentId} 下载 ${filename}`);
    } catch {
      // 下载登记失败不能影响页面本身
    }
  });
}
