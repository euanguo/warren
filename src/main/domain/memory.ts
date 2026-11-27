/**
 * 纯领域内存归因与压力水位决策引擎（无 Electron 依赖，支持 node --test 直接单测）。
 *
 * 关键不变量：
 * 1. 同 Session / 同源多标签可能共享同一 Chromium Renderer OS PID，
 *    所有总计与环境小计都严格按 PID 去重，绝不重复相加虚报内存；
 * 2. 内存压力自动回收遵循迟滞（hysteresis）原则，超软顶触发后只回收到 85% 安全水位，
 *    并绝不触碰当前显示、Agent 持权、Pin 固定或活跃音频/录制中的环境。
 */
import type {
  EnvMemoryProtectionReason,
  EnvironmentStatus,
  MemoryEnvAttribution,
  MemoryPluginAttribution,
  MemoryPressureLevel,
  MemoryProcessEntry,
  MemorySnapshot,
  MemoryTabAttribution,
  PluginRuntime,
  PluginStatus,
  ProcessCategory,
  SpaceId,
} from '../../shared/types.ts';

export interface RawAppMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  workingSetSizeKb: number;
  privateBytesKb?: number;
  cpuPercent: number;
}

export interface RawTabProcessInfo {
  id: string;
  space: SpaceId;
  title: string;
  url: string;
  active: boolean;
  sleeping: boolean;
  audible: boolean;
  pid?: number;
}

export interface RawEnvProcessInfo {
  id: string;
  name: string;
  status: EnvironmentStatus;
  idleSeconds: number;
  pinned: boolean;
  protectedReason?: EnvMemoryProtectionReason;
  tabs: RawTabProcessInfo[];
}

export interface RawPluginProcessInfo {
  id: string;
  name: string;
  runtime: PluginRuntime;
  status: PluginStatus;
  pid?: number;
}

export interface RawShellProcessInfo {
  pid: number;
  label: string;
}

export interface AggregateMemoryInput {
  capturedAt?: string;
  softLimitMb: number;
  systemTotalKb: number;
  systemFreeKb: number;
  metrics: RawAppMetric[];
  environments: RawEnvProcessInfo[];
  plugins: RawPluginProcessInfo[];
  shellProcesses: RawShellProcessInfo[];
}

export const MEMORY_PRESSURE_HYSTERESIS_RATIO = 0.85;

function roundCpu(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 10) / 10;
}

function safeKb(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

/** 判定当前内存压力等级。设了软顶按软顶比例判，不限时退回宿主机空闲比例。 */
export function evaluateMemoryPressure(
  totalMemoryKb: number,
  softLimitMb: number,
  systemTotalKb: number,
  systemFreeKb: number,
): MemoryPressureLevel {
  if (softLimitMb > 0) {
    const ratio = totalMemoryKb / (softLimitMb * 1024);
    if (ratio >= 0.95) return 'high';
    if (ratio >= 0.75) return 'elevated';
    return 'normal';
  }
  if (systemTotalKb > 0) {
    const freeRatio = systemFreeKb / systemTotalKb;
    if (freeRatio <= 0.1) return 'high';
    if (freeRatio <= 0.18) return 'elevated';
  }
  return 'normal';
}

/** 将原始进程指标按 PID 去重并归因到环境 / 标签 / 插件 / 壳层 / 系统底座。 */
export function aggregateMemorySnapshot(input: AggregateMemoryInput): MemorySnapshot {
  // 1. 按 PID 去重原始进程指标
  const metricByPid = new Map<number, RawAppMetric>();
  for (const raw of input.metrics) {
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) continue;
    const prev = metricByPid.get(raw.pid);
    if (!prev || safeKb(raw.workingSetSizeKb) > safeKb(prev.workingSetSizeKb)) {
      metricByPid.set(raw.pid, {
        ...raw,
        workingSetSizeKb: safeKb(raw.workingSetSizeKb),
        privateBytesKb: raw.privateBytesKb === undefined ? undefined : safeKb(raw.privateBytesKb),
        cpuPercent: roundCpu(raw.cpuPercent),
      });
    }
  }

  // 2. 建立 PID -> 归属反查表
  const tabCountByPid = new Map<number, number>();
  const envIdsByPid = new Map<number, Set<string>>();
  for (const env of input.environments) {
    for (const tab of env.tabs) {
      if (tab.sleeping || !tab.pid || tab.pid <= 0) continue;
      tabCountByPid.set(tab.pid, (tabCountByPid.get(tab.pid) ?? 0) + 1);
      let owners = envIdsByPid.get(tab.pid);
      if (!owners) {
        owners = new Set();
        envIdsByPid.set(tab.pid, owners);
      }
      owners.add(env.id);
    }
  }

  const pluginByPid = new Map<number, RawPluginProcessInfo>();
  const pluginByServiceName = new Map<string, RawPluginProcessInfo>();
  for (const plugin of input.plugins) {
    pluginByServiceName.set(`warren-plugin-${plugin.id}`, plugin);
    if (plugin.pid && plugin.pid > 0) {
      pluginByPid.set(plugin.pid, plugin);
    }
  }
  // 兜底：若 utilityProcess 尚未回填 pid，可通过 serviceName 匹配归属
  for (const metric of metricByPid.values()) {
    if (!pluginByPid.has(metric.pid) && metric.serviceName) {
      const matched = pluginByServiceName.get(metric.serviceName);
      if (matched) pluginByPid.set(metric.pid, matched);
    }
  }

  const shellLabelByPid = new Map<number, string>();
  for (const shell of input.shellProcesses) {
    if (shell.pid <= 0) continue;
    const existing = shellLabelByPid.get(shell.pid);
    if (!existing) shellLabelByPid.set(shell.pid, shell.label);
    else if (!existing.includes(shell.label)) shellLabelByPid.set(shell.pid, `${existing} + ${shell.label}`);
  }

  // 3. 归类每个唯一 PID，构建去重总账与分项堆叠
  const processes: MemoryProcessEntry[] = [];
  let totalMemoryKb = 0;
  let environmentsKb = 0;
  let pluginsKb = 0;
  let shellKb = 0;
  let systemKb = 0;

  for (const metric of metricByPid.values()) {
    const kb = metric.workingSetSizeKb;
    totalMemoryKb += kb;

    const envOwners = envIdsByPid.get(metric.pid);
    const pluginOwner = pluginByPid.get(metric.pid);
    const shellLabel = shellLabelByPid.get(metric.pid);

    let category: ProcessCategory;
    let label: string;
    if (envOwners && envOwners.size > 0) {
      category = 'environment';
      const ids = [...envOwners];
      const count = tabCountByPid.get(metric.pid) ?? 1;
      label = count > 1 ? `环境渲染进程 (${ids.join(', ')} · ${count} 标签共享)` : `环境渲染进程 (${ids[0]})`;
      environmentsKb += kb;
    } else if (pluginOwner) {
      category = 'plugin';
      label = `插件 ${pluginOwner.name} (${pluginOwner.id})`;
      pluginsKb += kb;
    } else if (shellLabel) {
      category = 'shell';
      label = shellLabel;
      shellKb += kb;
    } else if (metric.type === 'GPU') {
      category = 'system';
      label = 'GPU 合成进程';
      systemKb += kb;
    } else {
      category = 'system';
      label = metric.serviceName || metric.name || (metric.type === 'Browser' ? 'Warren 主进程' : metric.type);
      systemKb += kb;
    }

    processes.push({
      pid: metric.pid,
      type: metric.type,
      category,
      label,
      memoryKb: kb,
      ...(metric.privateBytesKb === undefined ? {} : { privateKb: metric.privateBytesKb }),
      cpuPercent: metric.cpuPercent,
      ...(envOwners && envOwners.size > 0
        ? { envIds: [...envOwners], tabCount: tabCountByPid.get(metric.pid) ?? 1 }
        : {}),
      ...(pluginOwner ? { pluginId: pluginOwner.id } : {}),
    });
  }
  processes.sort((a, b) => b.memoryKb - a.memoryKb || a.pid - b.pid);

  // 4. 聚合环境级视图（单环境内部严格按唯一 PID 去重）
  const protectedPids = new Set<number>();
  const reclaimablePids = new Set<number>();
  let totalActiveTabs = 0;
  let totalSleepingTabs = 0;

  const environments: MemoryEnvAttribution[] = input.environments.map((env) => {
    const pidSet = new Set<number>();
    let activeTabs = 0;
    let sleepingTabs = 0;
    const reclaimable = env.status === 'running' && !env.protectedReason;

    const tabs: MemoryTabAttribution[] = env.tabs.map((tab) => {
      if (tab.sleeping) {
        sleepingTabs += 1;
        totalSleepingTabs += 1;
        return {
          id: tab.id,
          space: tab.space,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          sleeping: true,
          audible: false,
          sharedPidCount: 0,
          memoryKb: 0,
        };
      }
      activeTabs += 1;
      totalActiveTabs += 1;
      const pid = tab.pid && tab.pid > 0 ? tab.pid : undefined;
      const metric = pid ? metricByPid.get(pid) : undefined;
      if (pid) {
        pidSet.add(pid);
        if (reclaimable) {
          reclaimablePids.add(pid);
        } else if (tab.active || tab.audible || env.protectedReason === 'leased') {
          protectedPids.add(pid);
        } else {
          // 受保护环境下的后台非激活、非发声标签：若未与活跃标签共享 PID 则可释放
          reclaimablePids.add(pid);
        }
      }
      return {
        id: tab.id,
        space: tab.space,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        sleeping: false,
        audible: tab.audible,
        ...(pid ? { pid } : {}),
        sharedPidCount: pid ? (tabCountByPid.get(pid) ?? 1) : 0,
        memoryKb: metric?.workingSetSizeKb ?? 0,
      };
    });

    const pids = [...pidSet];
    let memoryKb = 0;
    let cpuPercent = 0;
    for (const pid of pids) {
      const m = metricByPid.get(pid);
      if (!m) continue;
      memoryKb += m.workingSetSizeKb;
      cpuPercent += m.cpuPercent;
    }

    return {
      id: env.id,
      name: env.name,
      status: env.status,
      memoryKb,
      cpuPercent: roundCpu(cpuPercent),
      activeTabs,
      sleepingTabs,
      pids,
      ...(env.protectedReason ? { protectedReason: env.protectedReason } : {}),
      idleSeconds: Math.max(0, Math.round(env.idleSeconds)),
      pinned: env.pinned,
      reclaimable,
      tabs,
    };
  });

  environments.sort((a, b) => {
    if (b.memoryKb !== a.memoryKb) return b.memoryKb - a.memoryKb;
    const rank = (s: EnvironmentStatus) => (s === 'running' ? 0 : s === 'dormant' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.name.localeCompare(b.name);
  });

  // 预计可释放内存 = 只归属可回收目标、且不与任何受保护活跃标签共享的唯一 PID 内存之和
  let reclaimableMemoryKb = 0;
  for (const pid of reclaimablePids) {
    if (protectedPids.has(pid)) continue;
    reclaimableMemoryKb += metricByPid.get(pid)?.workingSetSizeKb ?? 0;
  }

  // 5. 聚合插件视图
  const plugins: MemoryPluginAttribution[] = input.plugins
    .map((plugin) => {
      let resolvedPid = plugin.pid && plugin.pid > 0 ? plugin.pid : undefined;
      if (!resolvedPid) {
        for (const [pid, owner] of pluginByPid.entries()) {
          if (owner.id === plugin.id) {
            resolvedPid = pid;
            break;
          }
        }
      }
      const metric = resolvedPid ? metricByPid.get(resolvedPid) : undefined;
      return {
        id: plugin.id,
        name: plugin.name,
        runtime: plugin.runtime,
        status: plugin.status,
        ...(resolvedPid ? { pid: resolvedPid } : {}),
        memoryKb: metric?.workingSetSizeKb ?? 0,
        cpuPercent: metric?.cpuPercent ?? 0,
      };
    })
    .sort((a, b) => b.memoryKb - a.memoryKb || a.name.localeCompare(b.name));

  const runningEnvs = environments.filter((env) => env.status === 'running').length;
  const dormantEnvs = environments.filter((env) => env.status === 'dormant').length;
  const runningPlugins = plugins.filter((plugin) => plugin.status === 'running').length;
  const softLimitMb = Math.max(0, Math.round(input.softLimitMb));

  return {
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    totalMemoryKb,
    reclaimableMemoryKb,
    softLimitMb,
    pressure: evaluateMemoryPressure(totalMemoryKb, softLimitMb, input.systemTotalKb, input.systemFreeKb),
    systemTotalKb: safeKb(input.systemTotalKb),
    systemFreeKb: safeKb(input.systemFreeKb),
    breakdown: {
      environmentsKb,
      pluginsKb,
      shellKb,
      systemKb,
    },
    counts: {
      totalEnvs: environments.length,
      runningEnvs,
      dormantEnvs,
      activeTabs: totalActiveTabs,
      sleepingTabs: totalSleepingTabs,
      runningPlugins,
      processCount: processes.length,
    },
    environments,
    plugins,
    processes,
  };
}

/**
 * 内存水位超限时挑选应休眠的后台环境：
 * - 仅考虑 `reclaimable === true`（自动排除当前显示、Agent 持权、Pin 固定与活跃发声/忙碌环境）；
 * - 优先按内存占大头 + 闲置更久排序；
 * - 回收到预计总内存 <= `softLimitMb * 0.85` 即止（迟滞防抖动）。
 */
export function pickPressureHibernations(snapshot: MemorySnapshot, softLimitMb = snapshot.softLimitMb): string[] {
  if (softLimitMb <= 0) return [];
  const limitKb = softLimitMb * 1024;
  if (snapshot.totalMemoryKb <= limitKb) return [];
  const targetKb = Math.floor(limitKb * MEMORY_PRESSURE_HYSTERESIS_RATIO);

  const candidates = snapshot.environments
    .filter((env) => env.reclaimable && env.status === 'running')
    .sort((a, b) => {
      // 综合考量：优先释放最占内存或最久未用的后台环境
      if (b.memoryKb !== a.memoryKb) return b.memoryKb - a.memoryKb;
      return b.idleSeconds - a.idleSeconds;
    });

  const picked: string[] = [];
  let projectedKb = snapshot.totalMemoryKb;
  for (const env of candidates) {
    if (projectedKb <= targetKb) break;
    picked.push(env.id);
    projectedKb -= env.memoryKb;
  }
  return picked;
}
