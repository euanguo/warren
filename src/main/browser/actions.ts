/**
 * 弹窗与下载动作 + 动作层共享的输入/视觉反馈原语（`pointer-actions.ts` / `form-actions.ts` 共用）。
 */
import type { DownloadStatus, TargetInput } from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { richErr } from './errors.ts';
import { mousePath, STEP_DELAY_MS, type Point } from './input-synthesis.ts';
import { lastMouseOf, takePendingRelease } from './mouse-state.ts';
import { guardSavePath } from './policy.ts';
import { markDialogHandled } from './session.ts';

/** 动作名里带的目标摘要，进错误消息用。 */
export function tname(target: TargetInput): string {
  return typeof target === 'string' ? target : JSON.stringify(target).slice(0, 60);
}

/** 换算当前页面缩放比并向透明遮罩层播报动作位置（安全静默，永不中断主操作）。 */
export function emitVisualAction(
  ctx: PageContext,
  kind: 'click' | 'fill' | 'hover',
  x: number,
  y: number,
  rect?: { x: number; y: number; width: number; height: number },
  label?: string,
): void {
  if (!ctx.onVisualAction) return;
  try {
    const rawZoom = typeof ctx.wc.getZoomFactor === 'function' ? ctx.wc.getZoomFactor() : 1;
    const zoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
    ctx.onVisualAction({
      kind,
      x: Math.round(x * zoom),
      y: Math.round(y * zoom),
      ...(rect
        ? {
            rect: {
              x: Math.round(rect.x * zoom),
              y: Math.round(rect.y * zoom),
              width: Math.round(rect.width * zoom),
              height: Math.round(rect.height * zoom),
            },
          }
        : {}),
      ...(label ? { label: label.slice(0, 48) } : {}),
    });
  } catch {
    // 动画播报层永不影响真实操作
  }
}

/**
 * 是否开启贝塞尔曲线鼠标移动：
 * - 显式传入 `opts.humanize` 时优先听调用方；
 * - 否则仅当 `WARREN_INPUT_PATH=1` 时启用（默认直达，避免后台 tab 多步 mouseMoved 停顿）。
 */
function shouldHumanizeMove(humanize?: boolean): boolean {
  if (humanize !== undefined) return humanize;
  return process.env.WARREN_INPUT_PATH === '1';
}

/** 把鼠标移到目标坐标；按需走拟人化贝塞尔曲线。 */
export async function moveAlongPath(ctx: PageContext, to: Point, humanize?: boolean): Promise<void> {
  const lastMouse = lastMouseOf(ctx.wc);
  const points = shouldHumanizeMove(humanize) ? mousePath(lastMouse, to) : [to];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    await ctx.sendInput('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      buttons: 0,
      pointerType: 'mouse',
    });
    if (i < points.length - 1) await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
  }
  lastMouse.x = to.x;
  lastMouse.y = to.y;
}

/** 向指定坐标派发完整的鼠标按下/抬起序列（默认先移动鼠标）。 */
export async function dispatchMouseClick(
  ctx: PageContext,
  point: Point,
  opts: {
    move?: boolean;
    humanize?: boolean;
    button?: string;
    buttons?: number;
    clickCount?: number;
    modifiers?: number;
    delay?: number;
  } = {},
): Promise<void> {
  if (opts.move !== false) await moveAlongPath(ctx, point, opts.humanize);
  const button = opts.button ?? 'left';
  const buttons = opts.buttons ?? 1;
  const clickCount = opts.clickCount ?? 1;
  const modifiers = opts.modifiers ?? 0;
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button,
    buttons,
    clickCount,
    modifiers,
    pointerType: 'mouse',
  });
  if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
    pointerType: 'mouse',
  });
}

/** 若上次点击被 JS Dialog 截断留下未闭合的 `mousePressed`，在关闭弹窗后立即补发 `mouseReleased`。 */
async function flushPendingRelease(ctx: PageContext): Promise<void> {
  const pending = takePendingRelease(ctx.wc);
  if (!pending) return;
  await ctx
    .send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pending.x,
      y: pending.y,
      button: pending.button,
      buttons: 0,
      clickCount: pending.clickCount,
      pointerType: 'mouse',
    })
    .catch(() => {});
}

// ── 弹窗与下载 ────────────────────────────────────────────────────

export async function acceptDialog(ctx: PageContext, promptText?: string): Promise<{ ok: true; type: string }> {
  const current = ctx.pending.dialogOpen();
  const d = ctx.pending.takeDialogEvent();
  const type = d && d.kind === 'dialog' ? d.type : (current?.type ?? 'alert');
  await ctx.sendOn(current?.sessionId, 'Page.handleJavaScriptDialog', { accept: true, promptText });
  markDialogHandled(ctx.wc);
  await flushPendingRelease(ctx);
  return { ok: true, type };
}

export async function dismissDialog(ctx: PageContext): Promise<{ ok: true; type: string }> {
  const current = ctx.pending.dialogOpen();
  const d = ctx.pending.takeDialogEvent();
  const type = d && d.kind === 'dialog' ? d.type : (current?.type ?? 'alert');
  await ctx.sendOn(current?.sessionId, 'Page.handleJavaScriptDialog', { accept: false });
  markDialogHandled(ctx.wc);
  await flushPendingRelease(ctx);
  return { ok: true, type };
}

export async function downloadSaveAs(
  ctx: PageContext,
  downloadId: string,
  dest: string,
): Promise<{ ok: true; path: string }> {
  const target = guardSavePath(dest);
  const found = ctx.downloadById(downloadId);
  if (!found) throw richErr('DOWNLOAD_FAILED', `未知下载: ${downloadId}`);
  const { item } = found;
  if (item.isPaused()) item.resume();
  await new Promise<void>((resolve, reject) => {
    const state = item.getState();
    if (state === 'completed') return resolve();
    if (state === 'cancelled' || state === 'interrupted') {
      return reject(richErr('DOWNLOAD_FAILED', `下载失败 state=${state}`));
    }
    item.once('done', (_e, doneState) => {
      if (doneState === 'completed') resolve();
      else reject(richErr('DOWNLOAD_FAILED', `下载结束 state=${doneState}`));
    });
  });
  const { mkdir, copyFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(found.path, target);
  return { ok: true, path: target };
}

export function downloadCancel(ctx: PageContext, downloadId: string): { ok: true } {
  const found = ctx.downloadById(downloadId);
  if (!found) throw richErr('DOWNLOAD_FAILED', `未知下载: ${downloadId}`);
  found.item.cancel();
  return { ok: true };
}

export function downloadStatus(ctx: PageContext, downloadId: string): DownloadStatus {
  const found = ctx.downloadById(downloadId);
  if (!found) throw richErr('DOWNLOAD_FAILED', `未知下载: ${downloadId}`);
  const { item, url, filename } = found;
  const rawState = item.getState() as string;
  const state: DownloadStatus['state'] = rawState === 'progressing' ? 'pending' : (rawState as DownloadStatus['state']);
  return {
    downloadId,
    url,
    filename,
    state,
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
    path: state === 'completed' ? found.path : undefined,
  };
}
