import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type {
  ConsoleEntry,
  CookieSummary,
  NavigationState,
  NetHit,
  NetRule,
  NetworkEntry,
  SnapshotResult,
  SpaceId,
} from '@shared/types';

const TELEMETRY_POLL_MS = 1500;

export interface TelemetrySnapshot {
  envId?: string;
  space: SpaceId;
  logs: ConsoleEntry[];
  requests: NetworkEntry[];
  rules: NetRule[];
  hits: NetHit[];
  nav?: NavigationState;
  snapshot?: SnapshotResult;
  snapshotLoading: boolean;
  cookies?: CookieSummary[];
}

interface TargetConfig {
  envId?: string;
  running: boolean;
  space: SpaceId;
  activeTabId?: string;
  inspectorOpen: boolean;
  inspectorTab: string;
}

let target: TargetConfig = {
  envId: undefined,
  running: false,
  space: 'person',
  activeTabId: undefined,
  inspectorOpen: false,
  inspectorTab: 'events',
};

let state: TelemetrySnapshot = {
  envId: undefined,
  space: 'person',
  logs: [],
  requests: [],
  rules: [],
  hits: [],
  nav: undefined,
  snapshot: undefined,
  snapshotLoading: false,
  cookies: undefined,
};

let timer: ReturnType<typeof setInterval> | undefined;
let started = false;
let pullSeq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  ensureTelemetryListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function syncTimer(): void {
  const needsPolling =
    target.inspectorOpen &&
    Boolean(target.envId) &&
    target.running &&
    (target.inspectorTab === 'console' || target.inspectorTab === 'network' || target.inspectorTab === 'rules');
  if (needsPolling && !timer) {
    timer = setInterval(() => void pullTelemetry(true), TELEMETRY_POLL_MS);
  } else if (!needsPolling && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function pullNavOnly(): Promise<void> {
  if (typeof window === 'undefined' || !window.envApi) return;
  const { envId, running, space } = target;
  if (!envId || !running) {
    if (state.nav !== undefined) {
      state = { ...state, envId, space, nav: undefined };
      emit();
    }
    return;
  }
  const seq = ++pullSeq;
  try {
    const nav = (await window.envApi.navState(envId, space)) ?? undefined;
    if (seq !== pullSeq) return;
    if (target.envId !== envId || target.space !== space || !target.running) return;
    state = { ...state, envId, space, nav };
    emit();
  } catch {
    // 导航态获取失败时保持现有态，等待下次同步
  }
}

async function pullTelemetry(telemetryOnly = false): Promise<void> {
  if (typeof window === 'undefined' || !window.envApi) return;
  const { envId, running, space, inspectorOpen, inspectorTab } = target;
  if (!envId || !running) {
    if (state.logs.length || state.requests.length || state.rules.length || state.hits.length || state.nav) {
      state = {
        ...state,
        envId,
        space,
        logs: [],
        requests: [],
        rules: [],
        hits: [],
        nav: undefined,
      };
      emit();
    }
    return;
  }
  const seq = ++pullSeq;
  try {
    const navPromise = telemetryOnly ? Promise.resolve(state.nav) : window.envApi.navState(envId, space);
    if (!inspectorOpen) {
      const nav = (await navPromise) ?? undefined;
      if (seq !== pullSeq) return;
      state = { ...state, envId, space, nav };
      emit();
      return;
    }

    const [nav, logs, requests, rulesResult, hits] = await Promise.all([
      navPromise,
      inspectorTab === 'console' ? window.envApi.console(envId) : Promise.resolve(state.logs),
      inspectorTab === 'network' ? window.envApi.network(envId) : Promise.resolve(state.requests),
      inspectorTab === 'rules' ? window.envApi.netRules(envId) : Promise.resolve(null),
      inspectorTab === 'rules' ? window.envApi.netHits(envId, 100) : Promise.resolve(state.hits),
    ]);
    if (seq !== pullSeq) return;
    if (target.envId !== envId || !target.running) return;
    state = {
      ...state,
      envId,
      space,
      nav: nav ?? undefined,
      logs,
      requests,
      rules: rulesResult ? rulesResult.rules : state.rules,
      hits,
    };
    emit();
  } catch {
    // 遥测轮询失败时不打扰用户
  }
}

function ensureTelemetryListeners(): void {
  if (started || typeof window === 'undefined' || !window.envApi) return;
  started = true;
  window.envApi.onEnvDelta(() => {
    if (!target.envId || !target.running) return;
    if (target.inspectorOpen) void pullTelemetry(false);
    else void pullNavOnly();
  });
}

export function getTelemetrySnapshot(): TelemetrySnapshot {
  return state;
}

export function useTelemetryState(): TelemetrySnapshot {
  return useSyncExternalStore(subscribe, getTelemetrySnapshot, getTelemetrySnapshot);
}

/**
 * 同步当前观察目标。仅在 `inspectorOpen === true` 时启用按需遥测抓取/轮询；
 * 检查器关闭时零轮询，只按需刷新轻量 `navState`。
 */
export function configureTelemetryTarget(next: TargetConfig): void {
  ensureTelemetryListeners();
  const envChanged = target.envId !== next.envId || target.running !== next.running;
  const navChanged = envChanged || target.space !== next.space || target.activeTabId !== next.activeTabId;
  const inspectorChanged =
    target.inspectorOpen !== next.inspectorOpen || (next.inspectorOpen && target.inspectorTab !== next.inspectorTab);

  target = next;
  if (envChanged) {
    state = {
      envId: next.envId,
      space: next.space,
      logs: [],
      requests: [],
      rules: [],
      hits: [],
      nav: undefined,
      snapshot: undefined,
      snapshotLoading: false,
      cookies: undefined,
    };
    emit();
  }
  syncTimer();
  if (next.inspectorOpen && (navChanged || inspectorChanged)) {
    void pullTelemetry(!navChanged);
    if (next.inspectorTab === 'storage' && next.envId && next.running) {
      void telemetryActions.readCookies(next.envId);
    }
  } else if (navChanged) {
    void pullNavOnly();
  }
}

export const telemetryActions = {
  readSnapshot: async (id: string, space: SpaceId): Promise<void> => {
    state = { ...state, snapshotLoading: true };
    emit();
    try {
      const data = await window.envApi.snapshot(id, space);
      if (target.envId === id) state = { ...state, snapshot: data, snapshotLoading: false };
      else state = { ...state, snapshotLoading: false };
      emit();
    } catch (error) {
      state = { ...state, snapshotLoading: false };
      emit();
      toast.error('读取快照失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  },
  readCookies: async (id: string): Promise<void> => {
    try {
      const list = await window.envApi.cookies(id);
      if (target.envId === id) {
        state = { ...state, cookies: list };
        emit();
      }
    } catch (error) {
      toast.error('读取存储失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  },
  toggleNetRule: async (id: string, ruleId: string, enabled: boolean): Promise<void> => {
    try {
      await window.envApi.netRuleSet(id, ruleId, enabled);
      await pullTelemetry(true);
    } catch (error) {
      toast.error('改网络规则失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
