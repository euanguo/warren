/**
 * 页面截图与 `--annotate` 视觉编号标注（隔离世界叠加 `@N` 标签框，截图完成立即移除）。
 */
import type { ScreenshotAnnotation, ScreenshotOptions, ScreenshotResult } from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { defaultScreenshotPath, guardScreenshotPath, imageSize, sha256Buffer, writeArtifact } from '../artifacts.ts';
import {
  canFallbackToElectronScreenshot,
  SCREENSHOT_CDP_TIMEOUT_MS,
  screenshotFallbackError,
} from './screenshot-policy.ts';
import { assignRefs, snapshot } from './snapshot.ts';
import { withTimeout } from './timeout.ts';

/**
 * 截屏，支持 `--annotate` 在隔离世界叠加临时 `@N` 编号标签框（截图完毕立刻移除）。
 */
export async function screenshot(
  ctx: PageContext,
  opts: ScreenshotOptions = {},
  environmentId?: string,
): Promise<ScreenshotResult> {
  let annotations: ScreenshotAnnotation[] | undefined;
  let annotateContextId: number | undefined;

  if (opts.annotate) {
    const nodes = await snapshot(ctx, { interactiveOnly: true, boxes: true, includeCursor: true });
    assignRefs(ctx, nodes);
    annotations = nodes
      .filter((n) => n.ref && n.box && n.box.width > 0 && n.box.height > 0)
      .slice(0, 80)
      .map((n) => ({
        ref: n.ref!,
        role: n.role,
        name: n.name.slice(0, 60),
        box: n.box!,
      }));
    if (annotations.length > 0) {
      try {
        const tree = await ctx.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree');
        const fid = tree?.frameTree?.frame?.id;
        if (fid) {
          const world = await ctx.send<{ executionContextId?: number }>('Page.createIsolatedWorld', {
            frameId: fid,
            worldName: 'warren-annotate',
          });
          annotateContextId = world?.executionContextId;
          if (annotateContextId) {
            await ctx.send('Runtime.evaluate', {
              contextId: annotateContextId,
              returnByValue: true,
              expression: `(() => {
                const items = ${JSON.stringify(annotations)};
                const old = document.getElementById('__warren_annotate_layer');
                if (old) old.remove();
                const layer = document.createElement('div');
                layer.id = '__warren_annotate_layer';
                layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
                for (const item of items) {
                  const box = document.createElement('div');
                  box.style.cssText =
                    'position:fixed;box-sizing:border-box;border:2px solid #ef4444;background:rgba(239,68,68,0.08);pointer-events:none;' +
                    'left:' + item.box.x + 'px;top:' + item.box.y + 'px;width:' + item.box.width + 'px;height:' + item.box.height + 'px;';
                  const tag = document.createElement('span');
                  tag.textContent = item.ref;
                  tag.style.cssText =
                    'position:absolute;top:-16px;left:0;background:#ef4444;color:#fff;font:600 11px/14px monospace;padding:1px 4px;border-radius:3px;white-space:nowrap;';
                  box.appendChild(tag);
                  layer.appendChild(box);
                }
                (document.body || document.documentElement).appendChild(layer);
                return items.length;
              })()`,
            });
          }
        }
      } catch {
        // 标注覆盖失败不影响主截图
      }
    }
  }

  try {
    const format = opts.format ?? 'png';
    const params: Record<string, unknown> = { format };
    if (opts.fullPage) params.captureBeyondViewport = true;
    if (opts.clip) {
      params.clip = {
        x: opts.clip.x,
        y: opts.clip.y,
        width: opts.clip.width,
        height: opts.clip.height,
        scale: 1,
      };
    }
    let buffer: Buffer;
    let source: 'cdp' | 'electron' = 'cdp';
    try {
      const { data } = await withTimeout(
        ctx.send<{ data: string }>('Page.captureScreenshot', params),
        SCREENSHOT_CDP_TIMEOUT_MS,
        `CDP screenshot timed out after ${SCREENSHOT_CDP_TIMEOUT_MS}ms`,
      );
      buffer = Buffer.from(data, 'base64');
    } catch (error) {
      const fallback = await captureVisiblePage(ctx, format, opts);
      if (!fallback.buffer) throw screenshotFallbackError(fallback.error ?? error);
      buffer = fallback.buffer;
      source = 'electron';
    }
    const wantsBase64 = opts.encoding === 'base64';
    const target =
      opts.path ?? (wantsBase64 ? undefined : defaultScreenshotPath(environmentId ?? String(ctx.tabIndex()), format));
    const extra = annotations ? { annotations } : {};
    if (target) {
      const meta = await writeArtifact(guardScreenshotPath(target), buffer);
      const size = imageSize(buffer, format);
      return {
        ...meta,
        format,
        ...size,
        source,
        ...extra,
        ...(wantsBase64 ? { base64: buffer.toString('base64') } : {}),
      };
    }
    const size = imageSize(buffer, format);
    return {
      bytes: buffer.length,
      sha256: sha256Buffer(buffer),
      format,
      ...size,
      source,
      ...extra,
      base64: buffer.toString('base64'),
    };
  } finally {
    if (annotateContextId) {
      await ctx
        .send('Runtime.evaluate', {
          contextId: annotateContextId,
          returnByValue: true,
          expression: `document.getElementById('__warren_annotate_layer')?.remove()`,
        })
        .catch(() => {});
    }
  }
}

async function captureVisiblePage(
  ctx: PageContext,
  format: 'png' | 'jpeg',
  opts: ScreenshotOptions,
): Promise<{ buffer?: Buffer; error?: unknown }> {
  if (!canFallbackToElectronScreenshot(opts)) return { error: 'fullPage/clip 不能走 Electron 兜底' };
  if (ctx.wc.isDestroyed()) return { error: 'webContents 已销毁' };
  try {
    const image = await ctx.wc.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) return { error: 'NativeImage 为空' };
    return { buffer: format === 'jpeg' ? image.toJPEG(92) : image.toPNG() };
  } catch (error) {
    return { error };
  }
}
