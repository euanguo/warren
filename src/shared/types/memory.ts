import type { EnvironmentStatus, SpaceId } from './common.ts';
import type { PluginRuntime, PluginStatus } from './plugin.ts';

/** 内存压力水位等级。 */
export type MemoryPressureLevel = 'normal' | 'elevated' | 'high';

/** 进程内存归属大类。 */
export type ProcessCategory = 'environment' | 'plugin' | 'shell' | 'system';

/** LRU 达到并发环境上限时的动作。 */
export type LruEvictAction = 'hibernate' | 'stop';

/** 环境免自动回收/休眠的保护原因。 */
export type EnvMemoryProtectionReason = 'selected' | 'leased' | 'pinned' | 'audible' | 'busy';

/** 单个标签的内存归因视图。多标签共享同一 Chromium 渲染进程时通过 `sharedPidCount` 显式标出。 */
export interface MemoryTabAttribution {
  id: string;
  space: SpaceId;
  title: string;
  url: string;
  active: boolean;
  sleeping: boolean;
  audible: boolean;
  pid?: number;
  /** 与当前标签共享同一 OS PID 的标签总数（>=2 表示共享进程，汇总时只计一次）。 */
  sharedPidCount: number;
  /** 该标签所在 OS 进程的工作集内存（KB）；休眠态为 0。 */
  memoryKb: number;
}

/** 单个环境的去重内存归因视图。 */
export interface MemoryEnvAttribution {
  id: string;
  name: string;
  status: EnvironmentStatus;
  /** 该环境所持唯一 OS PID 的工作集内存之和（KB，已按 PID 去重）。 */
  memoryKb: number;
  cpuPercent: number;
  activeTabs: number;
  sleepingTabs: number;
  pids: number[];
  protectedReason?: EnvMemoryProtectionReason;
  idleSeconds: number;
  pinned: boolean;
  /** 是否可通过「一键休眠后台环境」安全释放内存。 */
  reclaimable: boolean;
  tabs: MemoryTabAttribution[];
}

/** 单个插件工作进程的内存归因视图。 */
export interface MemoryPluginAttribution {
  id: string;
  name: string;
  runtime: PluginRuntime;
  status: PluginStatus;
  pid?: number;
  memoryKb: number;
  cpuPercent: number;
}

/** 去重后的单条 OS 进程指标。 */
export interface MemoryProcessEntry {
  pid: number;
  type: string;
  category: ProcessCategory;
  label: string;
  memoryKb: number;
  privateKb?: number;
  cpuPercent: number;
  envIds?: string[];
  pluginId?: string;
  tabCount?: number;
}

/** 主进程采样的全局内存快照（跨 IPC / CLI RPC 边界，全部按 PID 去重）。 */
export interface MemorySnapshot {
  capturedAt: string;
  /** Warren 全部相关进程的去重工作集总内存（KB）。 */
  totalMemoryKb: number;
  /** 当前可通过「一键休眠后台环境 + 释放非活跃标签」预计回收的内存（KB）。 */
  reclaimableMemoryKb: number;
  /** 软水位上限（MB，0 表示不限）。 */
  softLimitMb: number;
  pressure: MemoryPressureLevel;
  systemTotalKb: number;
  systemFreeKb: number;
  breakdown: {
    environmentsKb: number;
    pluginsKb: number;
    shellKb: number;
    systemKb: number;
  };
  counts: {
    totalEnvs: number;
    runningEnvs: number;
    dormantEnvs: number;
    activeTabs: number;
    sleepingTabs: number;
    runningPlugins: number;
    processCount: number;
  };
  environments: MemoryEnvAttribution[];
  plugins: MemoryPluginAttribution[];
  processes: MemoryProcessEntry[];
}
