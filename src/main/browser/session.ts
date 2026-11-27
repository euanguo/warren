/**
 * CDP 会话层：`webContents.debugger` 的薄封装 + dialog 消息分发。
 *
 * 只开 Page 域（`Page.enable`），`Runtime.enable / Network.enable` 不开——
 * 遥测走原生事件（HANDOFF §3.7），省检测面。
 * controller 持有长期 attach（构造时拿、销毁时放）；send 只发命令不碰计数。
 */
import type { WebContents } from 'electron';

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
  url: string;
  /**
   * dialog 开在哪个会话里。
   *
   * 跨源 iframe 里弹的 alert 是**子会话**的事件，accept/dismiss 也必须发回那个子会话，
   * 否则主会话收不到应答——表现就是「页面卡住、后续输入全挂」（实测过的挂死模式）。
   */
  sessionId?: string;
  /** 有未处理的 dialog 时，后续输入会报 DIALOG_OPEN 而不是卡死。 */
  hasDialog: boolean;
}

export type DialogHandler = (info: { type: string; message: string; url: string }) => void;

/** `Page.fileChooserOpened`：谁触发了文件选择器（`backendNodeId` 只在由元素触发时存在）。 */
export interface FileChooserInfo {
  frameId?: string;
  mode?: string;
  backendNodeId?: number;
  at: string;
}

/**
 * 一个 OOPIF 子会话。
 *
 * 跨源 iframe 是**独立渲染进程**，它的 frame **不在主会话的 `Page.getFrameTree` 里**
 * （实测：含跨源 iframe 的页面，主会话只列出 1 个 frame），所以它的 AX 树、DOM、盒模型
 * 全都得在这个子会话里问。`Target.setAutoAttach({flatten:true})` 会在它 attach 上来时
 * 发 `Target.attachedToTarget`，带一个 `sessionId`，之后所有命令都能用这个 id 定向。
 */
export interface ChildSession {
  sessionId: string;
  targetId: string;
  /**
   * 这个子会话**自己的**根 frame id。
   *
   * `targetId ≠ frameId`（实测踩过）：校验「这个 backendNodeId 属于哪个 renderer」
   * 只能用会话自己的 `Page.getFrameTree` 根 frame id，拿 targetId 比永远对不上。
   * attach 上来时是异步问出来的，所以这里可能短暂为空。
   */
  frameId?: string;
  url: string;
}

interface WcState {
  count: number;
  wired: boolean;
  attachPromise?: Promise<void>;
  /** 当前**未处理**的 dialog（只有 accept/dismiss/导航才清）——`DIALOG_OPEN` 守卫看这个。 */
  dialog?: DialogInfo;
  /** dialog 是否还没被 `events()` / `waitForEvent` 读走（读走只清这个标记）。 */
  dialogQueued: boolean;
  /** 待消费的 fileChooser 事件（按 tab 记，读一条少一条）。 */
  fileChoosers: FileChooserInfo[];
  /** OOPIF 子会话（`Target.attachedToTarget` 建起来的）。 */
  children: Map<string, ChildSession>;
  handlers: Set<DialogHandler>;
}

const states = new WeakMap<WebContents, WcState>();

function stateFor(wc: WebContents): WcState {
  let s = states.get(wc);
  if (!s) {
    s = {
      count: 0,
      wired: false,
      dialogQueued: false,
      handlers: new Set(),
      fileChoosers: [],
      children: new Map(),
    };
    states.set(wc, s);
  }
  return s;
}

/** controller 长期持有：构造/首次使用时拿（并发调用共享同一 attachPromise，幂等不竞态）。 */
export async function attachSession(wc: WebContents): Promise<void> {
  const s = stateFor(wc);
  if (s.count > 0) {
    s.count += 1;
    if (s.attachPromise) await s.attachPromise;
    return;
  }
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3');
  }
  s.count = 1;
  if (!s.wired) {
    s.wired = true;
    wc.debugger.on('detach', () => {
      const cur = states.get(wc);
      if (!cur) return;
      cur.count = 0;
      cur.attachPromise = undefined;
      cur.children.clear();
      cur.dialog = undefined;
      cur.dialogQueued = false;
    });
    // 每个 webContents 只接一次 message（controller 换代不重复接）
    wc.debugger.on('message', (_event, method, params, sessionId) => {
      // 子会话的 attach / detach：仅收纳跨源 iframe，过滤 worker / service_worker
      if (method === 'Target.attachedToTarget') {
        const p = (params ?? {}) as {
          sessionId?: string;
          targetInfo?: { targetId?: string; type?: string; url?: string };
        };
        if (!p.sessionId || !p.targetInfo?.targetId) return;
        const targetType = p.targetInfo.type ?? 'iframe';
        if (targetType !== 'iframe' && targetType !== 'page') return;
        s.children.set(p.sessionId, {
          sessionId: p.sessionId,
          targetId: p.targetInfo.targetId,
          url: String(p.targetInfo.url ?? ''),
        });
        void primeChild(wc, s, p.sessionId);
        return;
      }
      if (method === 'Target.detachedFromTarget') {
        const p = (params ?? {}) as { sessionId?: string };
        if (p.sessionId) s.children.delete(p.sessionId);
        return;
      }
      if (method === 'Page.javascriptDialogOpening') {
        const p = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
          url?: string;
        };
        s.dialog = {
          type: String(p.type ?? 'alert'),
          message: String(p.message ?? ''),
          defaultPrompt: p.defaultPrompt,
          url: String(p.url ?? ''),
          hasDialog: true,
          /*
           * dialog 开在哪个会话里。**主会话的事件这里给的是空字符串**（不是 undefined），
           * 而 Electron 对 `sendCommand(…, '')` 直接报 "Empty session id is not allowed"，
           * 所以空串一律归一成 undefined。
           * 实测：跨源 iframe 里弹的 alert 走的还是**主会话**（url 是内层的），
           * 这个字段是给别的路径兜底的。
           */
          sessionId: sessionId || undefined,
        };
        s.dialogQueued = true;
        for (const h of [...s.handlers]) {
          try {
            h({ type: s.dialog.type, message: s.dialog.message, url: s.dialog.url });
          } catch {
            // 遥测式分发不能影响页面
          }
        }
        return;
      }
      // 子会话的其它事件不处理：fileChooser 只看主会话
      if (sessionId) return;
      if (method === 'Page.fileChooserOpened') {
        const p = (params ?? {}) as { frameId?: string; mode?: string; backendNodeId?: number };
        s.fileChoosers.push({
          frameId: p.frameId,
          mode: p.mode,
          backendNodeId: p.backendNodeId,
          at: new Date().toISOString(),
        });
        return;
      }
    });
  }
  s.attachPromise = (async () => {
    try {
      await wc.debugger.sendCommand('Page.enable');
    } catch {
      // 页面正在销毁：attach 留着，调用方会收到目标错误
    }
    try {
      // 跨源 iframe 一 attach 上来就上报（flatten:true → 用 sessionId 定向，不再套一层会话）
      await wc.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch {
      // 老版本 / 已销毁：没有 OOPIF 支持也不该影响主会话
    }
  })();
  await s.attachPromise;
}

/** 子会话 attach 之后问出它自己的根 frame id（attach 事件里没有这个信息）。 */
async function primeChild(wc: WebContents, s: WcState, sessionId: string): Promise<void> {
  try {
    await wc.debugger.sendCommand('Page.enable', {}, sessionId);
    const tree = (await wc.debugger.sendCommand('Page.getFrameTree', {}, sessionId)) as {
      frameTree?: { frame?: { id?: string } };
    };
    const child = s.children.get(sessionId);
    if (child) child.frameId = tree?.frameTree?.frame?.id;
  } catch {
    // 子 frame 可能在问的过程中就没了
  }
}

/** 当前挂着的 OOPIF 子会话。 */
export function childSessions(wc: WebContents): ChildSession[] {
  return [...(states.get(wc)?.children.values() ?? [])];
}

/**
 * 丢掉所有子会话。
 *
 * **必须在导航开始前调**（不是导航结束后）：子 frame 是在导航**过程中** attach 上来的，
 * 等导航结束再清会把刚拿到的会话一起丢掉（实测：AX 里始终没有跨源内容）。
 */
export function clearChildSessions(wc: WebContents): void {
  states.get(wc)?.children.clear();
}

const DEFAULT_CDP_SEND_TIMEOUT_MS = 45_000;

function withCdpTimeout<T>(promise: Promise<T>, method: string, timeoutMs = DEFAULT_CDP_SEND_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`CDP 命令 ${method} 超时（>${timeoutMs}ms）`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
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

/** 在指定会话里发命令；`sessionId` 为空就是主会话。 */
export function sendOn<T = unknown>(
  wc: WebContents,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  // 空串会被 Electron 直接拒（Empty session id is not allowed），当主会话处理
  return withCdpTimeout(wc.debugger.sendCommand(method, params, sessionId || undefined) as Promise<T>, method);
}

/** controller 销毁时放。 */
export function detachSession(wc: WebContents): void {
  const s = states.get(wc);
  if (!s) return;
  s.count = Math.max(0, s.count - 1);
  if (s.count === 0 && !wc.isDestroyed()) {
    s.children.clear();
    try {
      wc.debugger.detach();
    } catch {
      // 已销毁
    }
    states.delete(wc);
  }
}

/**
 * 开/关 file chooser 拦截。
 *
 * **只在等 fileChooser 事件期间打开**：开启后原生「打开文件」对话框不再弹出
 * （控制权归 CDP），常开会让人在可见页面上点文件框时没有任何反应。
 */
export async function setFileChooserInterception(wc: WebContents, enabled: boolean): Promise<void> {
  await send(wc, 'Page.setInterceptFileChooserDialog', { enabled });
}

/** 取一条 fileChooser 事件（没有就 null）。 */
export function takeFileChooser(wc: WebContents): FileChooserInfo | null {
  return states.get(wc)?.fileChoosers.shift() ?? null;
}

/**
 * 当前还开着的 dialog（不受 `events()` 读取影响）。
 *
 * 和事件队列分开是有原因的：`events()` 读走的是事件副本，浏览器侧的 dialog 还开着，
 * `DIALOG_OPEN` 守卫必须照样拦得住，否则导航会被渲染进程挂到 RPC 超时（实测踩过）。
 */
export function peekDialog(wc: WebContents): DialogInfo | null {
  return states.get(wc)?.dialog ?? null;
}

/** 取走事件副本（events / waitForEvent 用）。不清「当前 dialog」，那是 markDialogHandled 的事。 */
export function takeDialog(wc: WebContents): DialogInfo | null {
  const s = states.get(wc);
  if (!s || !s.dialogQueued) return null;
  s.dialogQueued = false;
  return s.dialog ?? null;
}

/** dialog 已被 accept/dismiss，或随导航消失。 */
export function markDialogHandled(wc: WebContents): void {
  const s = states.get(wc);
  if (!s) return;
  s.dialog = undefined;
  s.dialogQueued = false;
}

/** 发 CDP 命令。调用方须已 attachSession（controller 构造时拿）。 */
export function send<T = unknown>(wc: WebContents, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return withCdpTimeout(wc.debugger.sendCommand(method, params) as Promise<T>, method);
}
