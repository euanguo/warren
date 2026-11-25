/**
 * 环境预检：在一次调用里回答「现在到底能不能开始业务断言」。
 *
 * 只读，不修环境。每项给出 ok / warn / error + 可执行 hint，便于 agent 先自检再跑用例。
 */
import type { EnvironmentManager } from './environments.ts';
import type { Store } from './store.ts';

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  detail?: unknown;
  hint?: string;
}

export interface DoctorResult {
  ok: boolean;
  environmentId: string;
  checks: DoctorCheck[];
}

async function probeLocalPort(port: number, pathname = '/'): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function runDoctor(
  manager: EnvironmentManager,
  _store: Store,
  environmentId: string,
  options: { localPorts?: number[] } = {},
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const environment = manager.get(environmentId);
  if (!environment) {
    return {
      ok: false,
      environmentId,
      checks: [
        {
          id: 'environment',
          status: 'error',
          message: `没有环境 ${environmentId}`,
          hint: `warren env list`,
        },
      ],
    };
  }
  checks.push({ id: 'environment', status: 'ok', message: `环境 ${environment.id} 存在` });
  checks.push({
    id: 'running',
    status: environment.status === 'running' ? 'ok' : 'error',
    message: `status=${environment.status}`,
    hint: environment.status === 'running' ? undefined : `warren env start ${environmentId}`,
  });

  const tabList = environment.tabs ?? [];
  const loginTab = tabList.find((tab) => /\/login(?:\?|$)/i.test(tab.url));
  checks.push({
    id: 'login',
    status: loginTab ? 'warn' : 'ok',
    message: loginTab ? `当前有页面停在登录：${loginTab.title || loginTab.url}` : '未发现登录跳转',
    detail: loginTab ? { url: loginTab.url, title: loginTab.title } : undefined,
    hint: loginTab ? '先完成登录或修正测试环境规则，再开始业务断言' : undefined,
  });

  checks.push({
    id: 'proxy',
    status: environment.proxy ? 'ok' : 'warn',
    message: environment.proxy ? `proxy=${environment.proxy}` : '直连（未配置代理）',
    hint: environment.proxy ? undefined : '如果是测试环境，先 bind Whistle 实例',
  });

  const netRules = manager.netRules(environmentId);
  checks.push({
    id: 'net-rules',
    status: environment.proxy && netRules.rules.length ? 'warn' : 'ok',
    message: `${netRules.rules.length} 条内置网络规则，命中 ${netRules.hits} 条`,
    detail: { rules: netRules.rules.length, hits: netRules.hits, recording: netRules.recording },
    hint:
      environment.proxy && netRules.rules.length
        ? '同一环境同时启用了内置 net 规则和 Whistle，可能互相抢请求'
        : undefined,
  });

  if (environment.trustedCa) {
    checks.push({
      id: 'trusted-ca',
      status: 'ok',
      message: `trustedCa=${environment.trustedCa}`,
    });
  } else if (environment.proxy) {
    checks.push({
      id: 'trusted-ca',
      status: 'warn',
      message: '有代理但没有 trustedCa；HTTPS 解密可能失败',
      hint: `在代理面板重新 bind ${environmentId}`,
    });
  }

  const ports = [...new Set((options.localPorts ?? []).filter((port) => Number.isInteger(port) && port > 0))];
  for (const port of ports) {
    const ok = await probeLocalPort(port);
    checks.push({
      id: `local-port-${port}`,
      status: ok ? 'ok' : 'warn',
      message: ok ? `127.0.0.1:${port} 可访问` : `127.0.0.1:${port} 无响应`,
      hint: ok ? undefined : `启动本地 dev server，或从预设变量里移除 ${port}`,
    });
  }

  const errors = checks.filter((check) => check.status === 'error');
  return { ok: errors.length === 0, environmentId, checks };
}
