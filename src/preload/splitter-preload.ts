/**
 * DevTools 停靠分割手柄 `WebContentsView` 的极简安全 Preload。
 * 仅暴露分割条拖拽与主进程同步两个单向通道，绝不接入 `envApi`。
 */
import { contextBridge, ipcRenderer } from 'electron';

export type DevToolsSplitterMessage =
  | { type: 'start'; screenX: number; screenY: number }
  | { type: 'move'; screenX: number; screenY: number }
  | { type: 'end'; screenX: number; screenY: number; cancel?: boolean }
  | { type: 'reset' };

export interface DevToolsSplitterSyncPayload {
  dock: 'right' | 'bottom';
  dragging: boolean;
  lineOffset: number;
  theme: 'dark' | 'light';
}

contextBridge.exposeInMainWorld('splitterBridge', {
  send: (message: DevToolsSplitterMessage) => {
    ipcRenderer.send('devtools:splitter', message);
  },
  onSync: (callback: (payload: DevToolsSplitterSyncPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DevToolsSplitterSyncPayload) => callback(payload);
    ipcRenderer.on('devtools:splitterSync', listener);
    return () => ipcRenderer.removeListener('devtools:splitterSync', listener);
  },
});
