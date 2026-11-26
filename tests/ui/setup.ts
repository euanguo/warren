import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type { EnvApi, PopoverActionEvent } from '@shared/types';

export interface MockEnvApiControls {
  api: EnvApi;
  openPopover: ReturnType<typeof vi.fn>;
  updatePopover: ReturnType<typeof vi.fn>;
  closePopover: ReturnType<typeof vi.fn>;
  dispatchPopoverAction: ReturnType<typeof vi.fn>;
  historySuggest: ReturnType<typeof vi.fn>;
  popupMenu: ReturnType<typeof vi.fn>;
  openOverlay: ReturnType<typeof vi.fn>;
  emitPopoverAction: (event: PopoverActionEvent) => void;
}

export function installMockEnvApi(overrides: Record<string, unknown> = {}): MockEnvApiControls {
  const popoverActionListeners = new Set<(event: PopoverActionEvent) => void>();

  const openPopover = vi.fn(async () => {});
  const updatePopover = vi.fn(async () => {});
  const closePopover = vi.fn(async () => {});
  const dispatchPopoverAction = vi.fn(async () => {});
  const historySuggest = vi.fn(async () => []);
  const popupMenu = vi.fn(async () => null);
  const openOverlay = vi.fn(async () => {});

  const base: Record<string, unknown> = {
    platform: 'darwin',
    openPopover,
    updatePopover,
    closePopover,
    dispatchPopoverAction,
    historySuggest,
    popupMenu,
    openOverlay,
    onPopoverAction: vi.fn((cb: (event: PopoverActionEvent) => void) => {
      popoverActionListeners.add(cb);
      return () => popoverActionListeners.delete(cb);
    }),
    getSettings: vi.fn(async () => ({
      theme: 'dark',
      compactTopbar: false,
      roundedWebView: true,
      approvalMode: 'confirm',
      approvalTimeoutSec: 60,
      defaultViewportPreset: 'auto',
      defaultDevToolsDock: 'right',
    })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
    getDiagnostics: vi.fn(async () => ({
      homeDir: '/Users/test/.warren',
      socketPath: '/Users/test/.warren/envd.sock',
      electronVersion: '45.5.0',
      chromeVersion: '136.0.0.0',
      nodeVersion: '24.22.0',
      platform: 'darwin',
      arch: 'arm64',
    })),
    vault: vi.fn(async () => ({ credentials: [], available: true })),
    vaultList: vi.fn(async () => []),
    pluginList: vi.fn(async () => []),
    extensionsList: vi.fn(async () => []),
    listEnvironments: vi.fn(async () => []),
    listGroups: vi.fn(async () => []),
    downloads: vi.fn(async () => []),
    getPagePrefs: vi.fn(async () => ({ zoom: 1, preset: 'auto' })),
    getDevToolsState: vi.fn(async () => ({ open: false, dock: 'right' })),
    getPopoverState: vi.fn(async () => null),
    doctor: vi.fn(async () => ({ ok: true, checks: [] })),
    ...overrides,
  };

  const api = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return vi.fn(() => () => {});
      }
      return vi.fn(async () => undefined);
    },
  }) as unknown as EnvApi;

  Object.defineProperty(window, 'envApi', {
    value: api,
    configurable: true,
    writable: true,
  });

  return {
    api,
    openPopover,
    updatePopover,
    closePopover,
    dispatchPopoverAction,
    historySuggest,
    popupMenu,
    openOverlay,
    emitPopoverAction: (event) => {
      for (const listener of popoverActionListeners) listener(event);
    },
  };
}

class StubResizeObserver {
  #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element): void {
    this.#callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

installMockEnvApi();

afterEach(() => {
  cleanup();
  installMockEnvApi();
});
