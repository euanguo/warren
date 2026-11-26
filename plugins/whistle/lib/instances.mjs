/**
 * Whistle 多实例进程托管与 Warren 环境代理/根证书绑定。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PORT_BASE,
  RULE_NAME,
  STORAGE_RE,
  envBoundTo,
  fail,
  loopbackPortOf,
  notifyChanged,
  readInstances,
  requireInstance,
  writeInstances,
} from './shared.mjs';
import {
  call,
  enableHttpsCapture,
  enableMultipleChoice,
  instancePid,
  pickPort,
  postForm,
  preflight,
  readRule,
  readRulesView,
  resolveW2,
  runW2,
  statusOf,
  waitForStatus,
  waitUntilGone,
  whistleEnv,
} from './w2-client.mjs';
import { ruleLine, upsertRule } from './rules-presets.mjs';

export async function describe(instance, environments, rulesView, status, settings) {
  const bound = envBoundTo(environments, instance.port);
  const pid = status && status.storage === instance.storage ? await instancePid(instance, settings) : null;
  const occupiedByOther = Boolean(status) && status.storage !== instance.storage;
  return {
    storage: instance.storage,
    port: instance.port,
    // 自动化必须能从同一份 live 实例清单定位 Whistle pid；不能再依赖
    // 全局 ~/.whistle_client.pid（多实例时它通常指向 8899/另一个实例）。
    pid,
    hostPattern: instance.hostPattern ?? '',
    targetPort: instance.targetPort ?? null,
    createdAt: instance.createdAt,
    // 端口有响应但 storage 对不上，说明跑的是别人的实例：alive 不能算 true
    alive: Boolean(status) && !occupiedByOther,
    version: status && !occupiedByOther ? status.version : null,
    portOccupant: status ? status.storage : null,
    allowMultipleChoice: Boolean(rulesView?.allowMultipleChoice),
    selected: Array.isArray(rulesView?.selected) ? rulesView.selected : [],
    rules: Array.isArray(rulesView?.rules) ? rulesView.rules : [],
    url: `http://127.0.0.1:${instance.port}`,
    environmentId: bound ? bound.id : null,
    environmentName: bound ? bound.name : null,
    environmentProxy: bound ? (bound.proxy ?? null) : null,
  };
}

/**
 * 同一端口被登记多次时只留一条：优先「端口上跑的就是它」，否则留最新登记的那条。
 * 其余进 `stale`（只报告，不自动删记录——删记录会丢 hostPattern/targetPort 线索）。
 *
 * 导出给单测：真实场景（审计 thr_xt933f3iiz「同端口新旧两个实例记录」）不好复现，
 * 但判定规则必须能被断言。
 */
export function splitDuplicatePorts(instances, statuses) {
  const byPort = new Map();
  for (const instance of instances) {
    const group = byPort.get(instance.port) ?? [];
    group.push(instance);
    byPort.set(instance.port, group);
  }
  const live = [];
  const stale = [];
  for (const [port, group] of byPort) {
    if (group.length === 1) {
      live.push(group[0]);
      continue;
    }
    const status = statuses.get(port);
    const occupant = status ? group.find((item) => item.storage === status.storage) : null;
    const newest = [...group].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const chosen = occupant ?? newest;
    live.push(chosen);
    for (const item of group) {
      if (item.storage === chosen.storage) continue;
      stale.push({
        storage: item.storage,
        port,
        reason: 'duplicate-port',
        liveStorage: chosen.storage,
        createdAt: item.createdAt ?? null,
      });
    }
  }
  const order = new Map(instances.map((item, index) => [item.storage, index]));
  live.sort((a, b) => (order.get(a.storage) ?? 0) - (order.get(b.storage) ?? 0));
  return { live, stale };
}

export async function listInstances(host) {
  const environments = await host.environment.list();
  const settings = await host.settings.get();
  const instances = await readInstances(host);
  const statuses = new Map();
  await Promise.all(
    [...new Set(instances.map((instance) => instance.port))].map(async (port) => {
      statuses.set(port, await statusOf(port));
    }),
  );
  const { live, stale } = splitDuplicatePorts(instances, statuses);
  const views = await Promise.all(
    live.map(async (instance) => {
      if (!statuses.get(instance.port)) return { rules: [], allowMultipleChoice: false, selected: [] };
      try {
        return await readRulesView(instance.port);
      } catch {
        return { rules: [], allowMultipleChoice: false, selected: [] };
      }
    }),
  );
  return {
    instances: await Promise.all(
      live.map((instance, index) =>
        describe(instance, environments, views[index], statuses.get(instance.port), settings),
      ),
    ),
    stale,
    environments: environments.map((env) => ({
      id: env.id,
      name: env.name,
      status: env.status,
      proxy: env.proxy ?? null,
    })),
    w2: await resolveW2(host)
      .then((command) => command.display)
      .catch((error) => `(未找到) ${error.message}`),
  };
}

// ── 动作 ─────────────────────────────────────────────────────────────

export async function forkInstance(host, input) {
  const requested = String((input && input.storage) || '').trim();
  const storage = requested || `dev-${Date.now().toString(36)}`;
  if (!STORAGE_RE.test(storage)) {
    fail('BAD_REQUEST', 'storage 只能用小写字母、数字和短横线，且以字母或数字开头');
  }
  const instances = await readInstances(host);
  if (instances.some((item) => item.storage === storage)) {
    fail('WHISTLE_STORAGE_EXISTS', `已经登记过叫 ${storage} 的实例；换个名字或先把它删掉`);
  }

  const settings = await host.settings.get();
  const base = Number(settings.portBase) > 0 ? Number(settings.portBase) : DEFAULT_PORT_BASE;
  const wanted = Number(input && input.port);
  let port = wanted > 0 ? wanted : await pickPort(base);
  if (wanted > 0) {
    if (await statusOf(port)) fail('WHISTLE_PORT_BUSY', `端口 ${port} 上已经有一个 whistle 实例了`);
  } else {
    /*
     * `canBind` 会放过「别人占着、但绑在另一个地址族」的端口（实测 8900 被 IPv6 侧占着，
     * 127.0.0.1 还能 bind 成功），所以选完端口还要再用状态探一次，撞了就顺延。
     */
    for (let attempt = 0; attempt < 5 && (await statusOf(port)); attempt += 1) port = await pickPort(port + 1);
    if (await statusOf(port)) fail('WHISTLE_NO_FREE_PORT', `从 ${base} 往后选的 5 个端口上都已经有 whistle 实例`);
  }
  const registered = instances.find((item) => item.port === port);
  if (registered) {
    fail(
      'WHISTLE_PORT_REGISTERED',
      `端口 ${port} 已经登记给实例 ${registered.storage}；用 start 把它按原端口拉起来，或换端口/先 remove。`,
    );
  }
  if (await statusOf(port)) fail('WHISTLE_PORT_BUSY', `端口 ${port} 上已经有一个 whistle 实例了`);

  const pre = await preflight(host);
  const env = await whistleEnv(host);
  const started = await runW2(pre.w2, ['start', '-S', storage, '-p', String(port)], env);
  const status = await waitForStatus(port, storage);
  if (!status) {
    fail(
      'WHISTLE_START_FAILED',
      `w2 start 之后 ${port} 上没有响应这个 storage 的实例。输出：${started.output || '(空)'}`,
    );
  }
  await enableHttpsCapture(port);
  await enableMultipleChoice(port);

  const hostPattern = String((input && input.hostPattern) || '').trim();
  const targetPort = Number(input && input.targetPort);
  if (hostPattern && targetPort > 0) {
    await upsertRule(port, RULE_NAME, ruleLine(hostPattern, targetPort));
    // 新实例的默认规则也要选中；开启多选后不能依赖「后写自动顶掉前一个」
    const selected = await postForm(port, '/cgi-bin/rules/project', { name: RULE_NAME, enable: '1' });
    if (selected.ec !== 0) fail('WHISTLE_RULE_ENABLE_FAILED', `新实例默认规则启用失败：${JSON.stringify(selected)}`);
    const activated = await readRule(port, RULE_NAME);
    if (!activated?.selected) fail('WHISTLE_RULE_ENABLE_UNCONFIRMED', '新实例默认规则回读 selected 仍不是 true');
  }

  const instance = {
    storage,
    port,
    hostPattern,
    targetPort: targetPort > 0 ? targetPort : null,
    createdAt: new Date().toISOString(),
  };
  await writeInstances(host, [...instances, instance]);
  await host.log.info(`实例 ${storage} 起在 ${port}（HTTPS 解密、多选规则已打开）`);
  await notifyChanged(host, 'fork', { storage, port });
  return {
    ...(await listInstances(host)),
    created: { storage, port, allowMultipleChoice: true },
    ...(pre.warnings.length ? { warnings: pre.warnings } : {}),
  };
}

/**
 * 把 `list` 里 `alive:false` 的已登记实例按原端口原 storage 拉起来。
 *
 * `open` 只开 Web UI（页面来自实例自己），实例没跑时它只会显示打不开的页面；
 * 「重启已登记实例」是独立动作，不能混在 open 里（审计 thr_xt933f3iiz：open 被当成启动）。
 */
export async function startInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const current = await statusOf(instance.port);
  if (current && current.storage === instance.storage) {
    return {
      ...(await listInstances(host)),
      started: { storage: instance.storage, port: instance.port, alreadyRunning: true },
    };
  }
  if (current) {
    fail(
      'WHISTLE_PORT_BUSY',
      `端口 ${instance.port} 上跑的是实例 ${current.storage}，不是 ${instance.storage}；先 stop 对方或改登记端口。`,
    );
  }
  const pre = await preflight(host);
  const env = await whistleEnv(host);
  const started = await runW2(pre.w2, ['start', '-S', instance.storage, '-p', String(instance.port)], env);
  const status = await waitForStatus(instance.port, instance.storage);
  if (!status) {
    fail(
      'WHISTLE_START_FAILED',
      `w2 start 之后 ${instance.port} 上没有响应 ${instance.storage} 的实例。输出：${started.output || '(空)'}`,
    );
  }
  await enableHttpsCapture(instance.port);
  await enableMultipleChoice(instance.port);
  await host.log.info(`实例 ${instance.storage} 已在原端口 ${instance.port} 重新拉起`);
  await notifyChanged(host, 'start', { storage: instance.storage, port: instance.port });
  return {
    ...(await listInstances(host)),
    started: {
      storage: instance.storage,
      port: instance.port,
      alreadyRunning: false,
      version: status.version ?? null,
    },
    ...(pre.warnings.length ? { warnings: pre.warnings } : {}),
  };
}

export async function stopInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) {
    return { ...(await listInstances(host)), note: '这个实例本来就没在跑' };
  }
  const w2 = await resolveW2(host);
  const stopped = await runW2(w2, ['stop', '-S', instance.storage], await whistleEnv(host), 10000);
  if (!(await waitUntilGone(instance.port))) {
    fail(
      'WHISTLE_STOP_FAILED',
      `w2 stop 之后 ${instance.port} 还在响应。这个实例可能不是这个 w2 起的（换过 WHISTLE_PATH？）。输出：${
        stopped.output || '(空)'
      }`,
    );
  }
  await host.log.info(`实例 ${instance.storage} 已停`);
  await notifyChanged(host, 'stop', { storage: instance.storage });
  return listInstances(host);
}

export async function removeInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (await statusOf(instance.port)) await stopInstance(host, input);
  const instances = await readInstances(host);
  await writeInstances(
    host,
    instances.filter((item) => item.storage !== instance.storage),
  );
  await notifyChanged(host, 'remove', { storage: instance.storage });
  // 只从登记表里摘掉：whistle 的规则文件还在磁盘上（想真删就自己去 WHISTLE_PATH 里删）
  return listInstances(host);
}

export async function bindEnvironment(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const environmentId = String((input && input.environmentId) || '').trim();
  if (!environmentId) fail('BAD_REQUEST', 'bind 需要 environmentId');
  const environment = await host.environment.get(environmentId);
  if (!environment) fail('ENV_NOT_FOUND', `没有环境 ${environmentId}`);
  const status = await statusOf(instance.port);
  if (!status) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑，先把它起起来`);
  if (status.storage && status.storage !== instance.storage) {
    fail('WHISTLE_INSTANCE_MISMATCH', `端口 ${instance.port} 当前运行的是 ${status.storage}，不是 ${instance.storage}`);
  }
  await enableMultipleChoice(instance.port);

  const response = await call(instance.port, '/cgi-bin/rootca?type=pem');
  const pem = await response.text();
  if (!pem.includes('BEGIN CERTIFICATE')) {
    fail('WHISTLE_ROOTCA_FAILED', `取不到 ${instance.storage} 的根证书`);
  }
  /*
   * CA 落在**环境自己的目录**里：它属于这个环境（环境删了就跟着没），
   * 也让「这个环境信谁」在磁盘上看得见。主进程只认这个路径，不需要知道 whistle。
   */
  const caPath = path.join(environment.storagePath, 'trusted-ca.pem');
  writeFileSync(caPath, pem);

  const proxy = `http://127.0.0.1:${instance.port}`;
  await host.environment.update({ id: environmentId, proxy, trustedCa: caPath });

  // proxy 只在 start() 时生效，所以「绑上就生效」必须重启
  const wasRunning = environment.status === 'running';
  if (wasRunning) {
    await host.environment.stop(environmentId);
    await host.environment.start(environmentId);
  }
  await host.log.info(`${environmentId} 已绑定到实例 ${instance.storage}（${proxy}）${wasRunning ? '，已重启' : ''}`);
  await notifyChanged(host, 'bind', { storage: instance.storage, environmentId });
  return {
    environmentId,
    proxy,
    trustedCa: caPath,
    restarted: wasRunning,
    // 证书失败会被网络服务按域名缓存；tab 上的验签兜底会绕过它，但也把限制说清楚
    ...(wasRunning
      ? {
          note: '若该域名此前已报过证书错，Chromium 会缓存失败结果；新标签会走验签兜底，若旧标签仍失败请重开该标签。',
        }
      : {}),
    ...(await listInstances(host)),
  };
}

export async function unbindEnvironment(host, input) {
  const environmentId = String((input && input.environmentId) || '').trim();
  if (!environmentId) fail('BAD_REQUEST', 'unbind 需要 environmentId');
  const environment = await host.environment.get(environmentId);
  if (!environment) fail('ENV_NOT_FOUND', `没有环境 ${environmentId}`);
  await host.environment.update({ id: environmentId, proxy: null, trustedCa: null });
  const wasRunning = environment.status === 'running';
  if (wasRunning) {
    await host.environment.stop(environmentId);
    await host.environment.start(environmentId);
  }
  await host.log.info(`${environmentId} 已解绑代理`);
  await notifyChanged(host, 'unbind', { environmentId });
  return { environmentId, restarted: wasRunning, ...(await listInstances(host)) };
}

/**
 * 在**这个环境自己的标签里**打开 whistle 的 Web UI。
 *
 * 以前是 spawn `open` 甩给系统浏览器 —— 那样人看到的抓包和我们环境里的页面是两回事，
 * 而且还得自己配代理。开成环境标签之后，它和页面在同一个 session 里，随环境启停。
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §4。
 */
export async function openBound(host, environmentId) {
  const id = String(environmentId || '').trim();
  if (!id) fail('BAD_REQUEST', 'open 需要 --env=<环境>');
  const environment = await host.environment.get(id);
  if (!environment) fail('ENV_NOT_FOUND', `没有环境 ${id}`);
  const port = loopbackPortOf(environment.proxy);
  if (!port) fail('WHISTLE_NOT_BOUND', `环境 ${id} 没有绑定代理实例（先绑一个，或用面板里的「绑定」）`);
  const url = `http://127.0.0.1:${port}`;
  const tab = await host.browser.openTab(url);
  // 只回 JSON 干净的字段：TabListItem 有可选字段（favicon / error），undefined 过不了 toJson
  return { url, tabId: String(tab.id), title: String(tab.title ?? '') };
}
