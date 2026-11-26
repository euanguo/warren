/**
 * 动态超时预算计算（纯函数，可单测）。
 *
 * 解决的问题：
 * 以前 CLI 的 RPC 超时是写死 60s（`WARREN_TIMEOUT_MS`），但 `batch` 一次跑 20 步
 * 或者用户显式传 `--timeout=90000` 时，客户端会抢在服务端动作超时历史返回前掐断连接，
 * Agent 只看到冷冰冰的 `RPC 超时`，丢掉了宝贵的重试诊断信息。
 */

export const BASE_RPC_TIMEOUT_MS = 60_000;
export const MAX_RPC_TIMEOUT_MS = 300_000;
export const CLIENT_BUFFER_MS = 5_000;

/**
 * 为指定 RPC 方法与参数推导客户端安全等待上限（始终比服务端预期上限多留 5s 缓冲）。
 */
export function computeRpcTimeoutMs(
  method: string,
  params: Record<string, unknown> = {},
  baseTimeoutMs = BASE_RPC_TIMEOUT_MS,
): number {
  const base = Number.isFinite(baseTimeoutMs) && baseTimeoutMs > 0 ? baseTimeoutMs : BASE_RPC_TIMEOUT_MS;
  let required = base;

  const explicitTimeout =
    typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? params.timeoutMs : undefined;
  if (explicitTimeout !== undefined && explicitTimeout > 0) {
    required = Math.max(required, explicitTimeout + CLIENT_BUFFER_MS);
  }

  if (method === 'browser.waitForTimeout' && typeof params.ms === 'number' && Number.isFinite(params.ms)) {
    required = Math.max(required, params.ms + CLIENT_BUFFER_MS);
  }

  if (method === 'browser.batch') {
    const stepCount = Array.isArray(params.steps)
      ? params.steps.length
      : typeof params.script === 'string'
        ? params.script
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#')).length
        : 1;
    // 每步预留 6s + 结算 4s + 缓冲 5s
    required = Math.max(required, stepCount * 6_000 + 9_000);
  }

  if (method === 'browser.read' && params.scroll) {
    const scrolls = typeof params.maxScrolls === 'number' && params.maxScrolls > 0 ? params.maxScrolls : 6;
    required = Math.max(required, scrolls * 2_000 + 20_000);
  }

  return Math.min(MAX_RPC_TIMEOUT_MS, Math.max(base, Math.round(required)));
}
