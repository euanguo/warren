/**
 * CLI Unix Socket RPC 客户端与租约生命周期管理（续租、等待取权、withLease 兜底释放）。
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { computeRpcTimeoutMs } from './output-guard.mjs';
import { warrenPaths } from './paths.mjs';

const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.WARREN_TIMEOUT_MS ?? 60_000);

export function createRpcClient({
  runtimeFile = path.join(warrenPaths().runtime, 'runtime.json'),
  callerLabel = 'warren',
  defaultTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
} = {}) {
  let runtime;
  let seq = 0;

  const runtimeInfo = () => {
    if (runtime) return runtime;
    try {
      runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
      return runtime;
    } catch {
      throw Object.assign(new Error('找不到运行中的核心。请先启动桌面端：npm start'), { code: 'CORE_NOT_RUNNING' });
    }
  };

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      let info;
      try {
        info = runtimeInfo();
      } catch (error) {
        reject(error);
        return;
      }
      const socket = net.connect(info.socketPath);
      let buffer = '';
      let settled = false;
      const id = String(++seq);
      const timeoutMs = computeRpcTimeoutMs(method, params, defaultTimeoutMs);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        socket.destroy();
        finish(reject, Object.assign(new Error(`RPC 超时 ${timeoutMs}ms: ${method}`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      socket.on('connect', () => socket.write(JSON.stringify({ id, token: info.token, method, params }) + '\n'));
      socket.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk.toString('utf8');
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        let message;
        try {
          message = JSON.parse(buffer.slice(0, index));
        } catch {
          socket.end();
          finish(reject, Object.assign(new Error('RPC 响应不是合法 JSON'), { code: 'BAD_RESPONSE' }));
          return;
        }
        socket.end();
        if (message.ok) finish(resolve, message.result);
        else
          finish(
            reject,
            Object.assign(new Error(message.error.message), {
              code: message.error.code,
              reason: message.error.reason,
              expiredAt: message.error.expiredAt,
              details: message.error.details,
            }),
          );
      });
      socket.on('error', (error) => finish(reject, error));
      socket.on('close', () => {
        if (!settled) {
          finish(reject, Object.assign(new Error(`RPC 连接意外关闭: ${method}`), { code: 'CONNECTION_CLOSED' }));
        }
      });
    });
  }

  function startLeaseRenewer(environmentId, leaseId, expiresAt) {
    // 兼容旧双参数调用（environmentId, expiresAt）
    let resolvedLeaseId = typeof leaseId === 'string' ? leaseId : undefined;
    let resolvedExpiresAt = typeof leaseId === 'number' ? leaseId : expiresAt;
    let stopped = false;
    let timer;
    const schedule = (until) => {
      const target = typeof until === 'number' && Number.isFinite(until) ? until : Date.now() + 60_000;
      const delay = Math.max(1000, Math.floor((target - Date.now()) / 2));
      timer = setTimeout(() => {
        if (!resolvedLeaseId) {
          stopped = true;
          return;
        }
        void call('env.renew', { id: environmentId, leaseId: resolvedLeaseId })
          .then((lease) => {
            if (!stopped) schedule(lease.expiresAt ?? lease.leaseExpiresAt ?? Date.now() + 60_000);
          })
          .catch((error) => {
            stopped = true;
            const reason = error?.reason ? `（reason=${error.reason}）` : '';
            console.error(
              `续租失败${reason}：${error?.code ?? 'ERROR'}: ${error?.message ?? error}；` +
                `脚本可以继续跑，但写操作会失败，先重新取控制权：warren env acquire ${environmentId}`,
            );
          });
      }, delay);
      timer.unref?.();
    };
    schedule(resolvedExpiresAt);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  async function withLease(environmentId, flags, label, fn) {
    let leaseId = typeof flags.lease === 'string' ? flags.lease : undefined;
    const auto = !leaseId;
    let stopRenewer = () => {};
    const effectiveLabel =
      typeof flags.label === 'string' ? flags.label : callerLabel !== 'warren' ? callerLabel : label;
    if (auto) {
      const lease = await call('env.acquire', { id: environmentId, label: effectiveLabel });
      leaseId = lease.leaseId;
      stopRenewer = startLeaseRenewer(environmentId, leaseId, lease.expiresAt ?? lease.leaseExpiresAt);
    }
    try {
      return await fn(leaseId);
    } finally {
      stopRenewer();
      // 单条命令结束后仅释放瞬时写锁，保留 Agent 空间托管会话态（思考期间蒙层常驻不闪烁，由 `env finish` 或人工结束）
      if (auto) await call('env.release', { id: environmentId, leaseId, keepSession: true }).catch(() => {});
    }
  }

  async function acquire(environmentId, flags) {
    const waitMs = typeof flags.wait === 'string' ? Number(flags.wait) : flags.wait === true ? 30_000 : 0;
    const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 0);
    const label = typeof flags.label === 'string' ? flags.label : callerLabel;
    for (;;) {
      try {
        return await call('env.acquire', { id: environmentId, label });
      } catch (error) {
        const retryable = error.code === 'ENV_BUSY' && Date.now() < deadline;
        if (!retryable) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  return { call, startLeaseRenewer, withLease, acquire, defaultTimeoutMs };
}
