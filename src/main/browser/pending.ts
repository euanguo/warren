/**
 * 每个 Environment 的待处理队列：popup / download 由**环境级**事件产生
 * （`window.open` 收敛、session `will-download`），任意标签的 controller 都能消费；
 * dialog 挂在 webContents 上（见 `session.ts`），这里只做转发。
 */
import type { WebContents } from 'electron';
import { peekDialog, takeDialog, takeFileChooser } from './session.ts';
import type { ActionReceipt, ActionSideEffects, PageEvent } from '../../shared/types.ts';
import type { PendingSink } from './ctx.ts';

export interface PopupRecord {
  tabId: string;
  /** 1-based 标签序号（和 UI / CLI 一致）。 */
  index: number;
  url: string;
  title?: string;
  at: string;
}

export interface DownloadRecord {
  downloadId: string;
  url: string;
  filename: string;
  at: string;
}

export interface DownloadHandle {
  item: Electron.DownloadItem;
  url: string;
  filename: string;
  path: string;
}

export class EnvPending {
  #popups: PopupRecord[] = [];
  #downloads: DownloadRecord[] = [];
  #byId = new Map<string, DownloadHandle>();
  /** 只保留最近 N 条下载：长驻环境反复下载时，这个表不能只增不减。 */
  #maxDownloads: number;

  constructor(options: { maxDownloads?: number } = {}) {
    this.#maxDownloads = options.maxDownloads ?? 50;
  }

  notePopup(record: PopupRecord): void {
    this.#popups.push(record);
    while (this.#popups.length > this.#maxDownloads) {
      this.#popups.shift();
    }
  }

  noteDownload(record: DownloadRecord, handle: DownloadHandle): void {
    this.#downloads.push(record);
    this.#byId.set(record.downloadId, handle);
    while (this.#downloads.length > this.#maxDownloads) {
      const dropped = this.#downloads.shift()!;
      this.#byId.delete(dropped.downloadId);
    }
    while (this.#byId.size > this.#maxDownloads) {
      const oldest = this.#byId.keys().next().value;
      if (oldest === undefined) break;
      this.#byId.delete(oldest);
    }
  }

  downloadById(downloadId: string): DownloadHandle | null {
    return this.#byId.get(downloadId) ?? null;
  }

  clear(): void {
    this.#popups = [];
    this.#downloads = [];
    this.#byId.clear();
  }

  /**
   * 给某个标签的 controller 一个消费口。
   * 队列在环境级，所以别的标签开的 popup 也能被这一条等出来（receipt 只报「动作开始之后」的）。
   */
  sinkFor(wc: WebContents): PendingSink {
    const dialogOf = () => peekDialog(wc);
    return {
      consumePopup: () => this.#popups.shift() ?? null,
      consumeDownload: () => this.#downloads.shift() ?? null,
      dialogOpen: () => {
        const d = dialogOf();
        return d ? { type: d.type, message: d.message, url: d.url, sessionId: d.sessionId } : null;
      },
      consumeFileChooser: () => takeFileChooser(wc),
      takeDialogEvent: (): PageEvent | null => {
        const d = takeDialog(wc);
        return d
          ? {
              kind: 'dialog',
              type: d.type,
              message: d.message,
              url: d.url,
              at: new Date().toISOString(),
            }
          : null;
      },
      receiptSince: (since): ActionReceipt => {
        const receipt: ActionReceipt = {};
        // `>=` 而不是 `>`：动作与 popup 落在同一毫秒时也要算「本次产生的」，
        // 用 `>` 会漏报刚开出来的标签。
        const popups = this.#popups
          .filter((p) => Date.parse(p.at) >= since)
          .map(({ tabId, index, url, title }) => ({ tabId, index, url, title }));
        if (popups.length > 0) receipt.popups = popups;
        const downloads = this.#downloads
          .filter((dl) => Date.parse(dl.at) >= since)
          .map(({ downloadId, url, filename }) => ({ downloadId, url, filename }));
        if (downloads.length > 0) receipt.downloads = downloads;
        const d = dialogOf();
        if (d) receipt.dialog = { type: d.type, message: d.message, url: d.url };
        return receipt;
      },
      peekUnhandled: (): ActionSideEffects => {
        const out: ActionSideEffects = {};
        if (this.#popups.length > 0) {
          out.unhandledPopups = this.#popups.slice(-5).map(({ tabId, index, url, title }) => ({
            tabId,
            index,
            url,
            title,
          }));
        }
        if (this.#downloads.length > 0) {
          out.activeDownloads = this.#downloads.slice(-5).map(({ downloadId, url, filename }) => ({
            downloadId,
            url,
            filename,
          }));
        }
        const d = dialogOf();
        if (d) out.openDialog = { type: d.type, message: d.message, url: d.url };
        return out;
      },
    };
  }
}
