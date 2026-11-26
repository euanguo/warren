import type { PageContext, VisualActionEvent } from '../../src/main/browser/ctx.ts';
import { RefTable } from '../../src/main/browser/refs.ts';

export interface FakeCdpCall {
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
}

export type CdpStubHandler = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => unknown | Promise<unknown>;

export interface FakePageHarness {
  ctx: PageContext;
  cdpCalls: FakeCdpCall[];
  inputCalls: FakeCdpCall[];
  visualActions: VisualActionEvent[];
  records: Array<{ type: string; message: string }>;
  setUrl(nextUrl: string): void;
  setDialog(dialog: { type: string; message: string; url: string; sessionId?: string } | null): void;
}

const VALID_1PX_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

export function createFakePageContext(
  options: {
    url?: string;
    destroyed?: boolean;
    capturedPng?: Buffer;
    tabIndex?: number;
    backendIds?: Record<string, number>;
    onSend?: CdpStubHandler;
    onSendInput?: CdpStubHandler;
  } = {},
): FakePageHarness {
  let url = options.url ?? 'https://example.test/app';
  let openDialog: { type: string; message: string; url: string; sessionId?: string } | null = null;
  const cdpCalls: FakeCdpCall[] = [];
  const inputCalls: FakeCdpCall[] = [];
  const visualActions: VisualActionEvent[] = [];
  const records: Array<{ type: string; message: string }> = [];
  const refs = new RefTable();

  const defaultSend: CdpStubHandler = async (method, params, sessionId) => {
    if (options.onSend) {
      const handled = await options.onSend(method, params, sessionId);
      if (handled !== undefined) return handled;
    }
    switch (method) {
      case 'DOM.getDocument':
        return { root: { nodeId: 1, backendNodeId: 1 } };
      case 'DOM.querySelector':
        return { nodeId: 10 };
      case 'DOM.describeNode':
        return { node: { backendNodeId: 100 } };
      case 'DOM.pushNodesByBackendIdsToFrontend': {
        const ids = (params?.backendNodeIds as number[] | undefined) ?? [];
        return { nodeIds: ids.map((id) => id + 1000) };
      }
      case 'DOM.scrollIntoViewIfNeeded':
        return {};
      case 'DOM.focus':
        return {};
      case 'DOM.resolveNode':
        return { object: { objectId: 'obj-1' } };
      case 'Runtime.releaseObject':
        return {};
      case 'Runtime.evaluate':
        return { result: { value: true } };
      case 'Runtime.callFunctionOn': {
        const decl = String(params?.functionDeclaration || '');
        if (decl.includes('floatingFlyout') || decl.includes('inViewport')) {
          return {
            result: {
              value: {
                visible: true,
                stable: true,
                enabled: true,
                editable: true,
                inert: false,
                inViewport: true,
                floatingFlyout: false,
                hit: { ok: true },
              },
            },
          };
        }
        if (decl.includes('menuitemcheckbox')) return { result: { value: false } };
        return { result: { value: true } };
      }
      case 'DOM.getBoxModel':
        return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
      case 'DOM.getContentQuads':
        return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 } };
      case 'DOM.getNodeForLocation':
        return { backendNodeId: 100 };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'frame-main' } } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 42 };
      case 'Page.captureScreenshot':
        return { data: VALID_1PX_PNG.toString('base64') };
      default:
        return {};
    }
  };

  const wc = {
    id: 101,
    getURL: () => url,
    isDestroyed: () => Boolean(options.destroyed),
    capturePage: async () => ({
      isEmpty: () => !options.capturedPng,
      toPNG: () => options.capturedPng ?? Buffer.alloc(0),
      toJPEG: () => options.capturedPng ?? Buffer.alloc(0),
    }),
  } as unknown as PageContext['wc'];

  const ctx: PageContext = {
    wc,
    refs,
    async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      cdpCalls.push({ method, params });
      return (await defaultSend(method, params, undefined)) as T;
    },
    async sendOn<T = unknown>(
      sessionId: string | undefined,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      cdpCalls.push({ sessionId, method, params });
      return (await defaultSend(method, params, sessionId)) as T;
    },
    childSessions: () => [],
    async sendInput(method: string, params: Record<string, unknown>): Promise<void> {
      inputCalls.push({ method, params });
      if (options.onSendInput) await options.onSendInput(method, params);
    },
    backendIdFor: async (target) => options.backendIds?.[String(target)] ?? 100,
    resolveTarget: async (target) => ({
      backendNodeId: options.backendIds?.[String(target)] ?? 100,
    }),
    frameOf: async () => undefined,
    downloadById: () => null,
    pending: {
      consumePopup: () => null,
      consumeDownload: () => null,
      dialogOpen: () => openDialog,
      takeDialogEvent: () => null,
      consumeFileChooser: () => null,
      receiptSince: () => ({}),
    },
    tabIndex: () => options.tabIndex ?? 1,
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    record: (type, message) => records.push({ type, message }),
    onVisualAction: (action) => visualActions.push(action),
  };

  return {
    ctx,
    cdpCalls,
    inputCalls,
    visualActions,
    records,
    setUrl: (next) => {
      url = next;
    },
    setDialog: (next) => {
      openDialog = next;
    },
  };
}
