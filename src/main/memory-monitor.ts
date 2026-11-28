/**
 * 实时内存采样与水位压力守卫（Electron 主进程适配器）。
 *
 * 融合 `app.getAppMetrics()`、`webContents.getOSProcessId()` 与 `PluginHost.pidOf()`，
 * 交给纯函数 `aggregateMemorySnapshot` 完成按 PID 去重归因；并在启用软水位时低频巡检，
 * 超限自动休眠可回收的后台环境并回收超时隐藏浮层。
 */
import { app, type BrowserWindow } from 'electron';
import os from 'node:os';
import type { MemorySnapshot } from '../shared/types.ts';
import { makeEvent } from './domain/environment.ts';
import {
  aggregateMemorySnapshot,
  pickPressureHibernations,
  type RawAppMetric,
  type RawPluginProcessInfo,
  type RawShellProcessInfo,
} from './domain/memory.ts';
import type { EnvironmentManager } from './environments.ts';
import type { PluginHost } from './plugins/host.ts';
import type { Store } from './store.ts';
import type { OverlayHost } from './ui/overlay-host.ts';
import type { PopoverHost } from './ui/popover-host.ts';
import type { TooltipHost } from './ui/tooltip-host.ts';

const PRESSURE_SWEEP_MS = 30_000;
const PRESSURE_COOLDOWN_MS = 60_000;
const SHELL_IDLE_RECLAIM_MS = 3 * 60_000;
const SNAPSHOT_CACHE_TTL_MS = 2_500;

export interface MemoryMonitorDeps {
  getWindow: () => BrowserWindow | undefined;
  getOverlayHost: () => OverlayHost | undefined;
  getPopoverHost: () => PopoverHost | undefined;
  getTooltipHost: () => TooltipHost | undefined;
  getManager: () => EnvironmentManager | undefined;
  getPlugins: () => PluginHost | undefined;
  store: Store;
}

export class MemoryMonitor {
  #deps: MemoryMonitorDeps;
  #softLimitMb = 6144;
  #timer?: ReturnType<typeof setInterval>;
  #lastPressureActionAt = 0;
  #cachedSnapshot?: { snap: MemorySnapshot; at: number };
  #inflightSnapshot?: Promise<MemorySnapshot>;

  constructor(deps: MemoryMonitorDeps) {
    this.#deps = deps;
  }

  configure(options: { softLimitMb?: number }): void {
    if (typeof options.softLimitMb === 'number' && Number.isFinite(options.softLimitMb)) {
      this.#softLimitMb = Math.max(0, Math.min(65_536, Math.round(options.softLimitMb)));
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.sweepPressure().catch(() => undefined);
    }, PRESSURE_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 主动回收隐藏态 Overlay / Popover 与未挂载输入护盾（`idleMs = 0` 表示立即回收）。 */
  reclaimShellSurfaces(idleMs = 0): number {
    const overlay = this.#deps.getOverlayHost()?.reclaimIdle(idleMs) ?? 0;
    const popover = this.#deps.getPopoverHost()?.reclaimIdle(idleMs) ?? 0;
    const tooltip = this.#deps.getTooltipHost()?.reclaimIdle(idleMs) ?? 0;
    const shield = this.#deps.getManager()?.reclaimIdleShield(idleMs) ?? 0;
    return overlay + popover + tooltip + shield;
  }

  /** 采集按 PID 去重后的完整内存快照（带 2.5s 短期缓存与并发去重，避免多视图同时轮询反复采样）。 */
  async snapshot(options: { force?: boolean } = {}): Promise<MemorySnapshot> {
    const now = Date.now();
    if (!options.force && this.#cachedSnapshot && now - this.#cachedSnapshot.at < SNAPSHOT_CACHE_TTL_MS) {
      return this.#cachedSnapshot.snap;
    }
    if (this.#inflightSnapshot) return this.#inflightSnapshot;
    const task = this.#collectSnapshot()
      .then((snap) => {
        this.#cachedSnapshot = { snap, at: Date.now() };
        return snap;
      })
      .finally(() => {
        if (this.#inflightSnapshot === task) this.#inflightSnapshot = undefined;
      });
    this.#inflightSnapshot = task;
    return task;
  }

  async #collectSnapshot(): Promise<MemorySnapshot> {
    const rawMetrics: RawAppMetric[] = app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name,
      serviceName: metric.serviceName,
      workingSetSizeKb: metric.memory?.workingSetSize ?? 0,
      privateBytesKb: metric.memory?.privateBytes,
      cpuPercent: metric.cpu?.percentCPUUsage ?? 0,
    }));

    const manager = this.#deps.getManager();
    const envInputs = manager ? manager.memoryInputs() : { environments: [], shellProcesses: [] };

    const shellProcesses: RawShellProcessInfo[] = [...envInputs.shellProcesses];
    const win = this.#deps.getWindow();
    if (win && !win.isDestroyed()) {
      const pid = win.webContents.getOSProcessId();
      if (Number.isInteger(pid) && pid > 0) shellProcesses.push({ pid, label: 'Warren 主窗口外壳' });
    }
    shellProcesses.push(...(this.#deps.getOverlayHost()?.processInfos() ?? []));
    shellProcesses.push(...(this.#deps.getPopoverHost()?.processInfos() ?? []));
    shellProcesses.push(...(this.#deps.getTooltipHost()?.processInfos() ?? []));

    const pluginHost = this.#deps.getPlugins();
    const pluginList = pluginHost ? await pluginHost.list().catch(() => []) : [];
    const plugins: RawPluginProcessInfo[] = pluginList.map((item) => ({
      id: item.id,
      name: item.name,
      runtime: item.runtime,
      status: item.status,
      pid: pluginHost?.pidOf(item.id),
    }));

    return aggregateMemorySnapshot({
      softLimitMb: this.#softLimitMb,
      systemTotalKb: Math.round(os.totalmem() / 1024),
      systemFreeKb: Math.round(os.freemem() / 1024),
      metrics: rawMetrics,
      environments: envInputs.environments,
      plugins,
      shellProcesses,
    });
  }

  /**
   * 周期性内存水位巡检：
   * 1. 超过 10 分钟未用的隐藏 Overlay/Popover 自动回收；
   * 2. 总内存超软顶且度过冷却期时，先休眠闲置标签，再按迟滞目标（85%）休眠非保护后台环境。
   */
  async sweepPressure(): Promise<{ sleptTabs: number; hibernated: string[]; reclaimedShells: number }> {
    const reclaimedShells = this.reclaimShellSurfaces(SHELL_IDLE_RECLAIM_MS);
    const manager = this.#deps.getManager();
    if (!manager || this.#softLimitMb <= 0 || !manager.hasRunningEnvironments()) {
      return { sleptTabs: 0, hibernated: [], reclaimedShells };
    }
    const now = Date.now();
    if (now - this.#lastPressureActionAt < PRESSURE_COOLDOWN_MS) {
      return { sleptTabs: 0, hibernated: [], reclaimedShells };
    }

    const snap = await this.snapshot({ force: true });
    if (snap.totalMemoryKb <= this.#softLimitMb * 1024) {
      return { sleptTabs: 0, hibernated: [], reclaimedShells };
    }

    this.#lastPressureActionAt = now;
    const sleptTabs = manager.sleepIdleTabs();
    const toHibernate = pickPressureHibernations(snap, this.#softLimitMb);
    const hibernated: string[] = [];
    for (const id of toHibernate) {
      if (manager.hibernate(id, `内存水位超出 ${Math.round((this.#softLimitMb / 1024) * 10) / 10} GB`)) {
        hibernated.push(id);
      }
    }
    if (sleptTabs > 0 || hibernated.length > 0) {
      this.#deps.store.record(
        makeEvent(
          'memory.pressure',
          `内存水位超限（${Math.round(snap.totalMemoryKb / 1024)} MB > ${this.#softLimitMb} MB）：休眠 ${hibernated.length} 个后台环境、释放 ${sleptTabs} 个非激活标签`,
          'system',
        ),
      );
    }
    return { sleptTabs, hibernated, reclaimedShells };
  }
}
