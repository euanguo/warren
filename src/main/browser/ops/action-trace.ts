/**
 * 零手写模板自动录制轨迹环（ActionTraceRing）：
 * - 按 env 保留最近 200 步写动作与触发的网络请求游标窗口 `[netBeforeId, netAfterId]`；
 * - **安全铁律**：严禁记录密码/TOTP/敏感字段输入值（`isSecret` 或目标含 password/otp/secret 一律抹除 value）；
 * - 将动作步骤与只读 GET 2xx XHR/Fetch 关联生成 `s<N>r<M>` 引用，自动检测某步输入值命中了哪个查询参数。
 */
import type { NetworkEntry } from '../../../shared/types.ts';
import { isSensitiveHeader, isSensitiveKey } from '../redact.ts';

export interface RecordedActionStep {
  stepId: string;
  seq: number;
  action: string;
  target?: string;
  /** 仅记录非敏感输入值（已自动排除 password/otp/secret/token）。 */
  value?: string;
  urlBefore: string;
  urlAfter: string;
  netBeforeId: number;
  netAfterId: number;
  at: string;
}

export interface MatchedFlowParam {
  param: string;
  value: string;
  sourceStepId: string;
}

export interface CorrelatedFlowCandidate {
  /** 短引用（如 `s3r1`，独立遥测无对应步骤时为 `r1`）。 */
  ref: string;
  stepId?: string;
  stepLabel?: string;
  method: 'GET';
  url: string;
  status: number;
  resourceType: string;
  suggestedTemplate: string;
  matchedParams?: MatchedFlowParam[];
}

const MAX_STEPS_PER_ENV = 200;
const SECRET_TARGET_RE = /(?:password|passwd|pwd|passcode|otp|totp|secret|token|cvv|pin)/i;
const SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|-----BEGIN )/i;
const STATIC_ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map|mp4|webm)(?:\?|$)/i;

function sanitizeStepValue(value?: string, target?: string, isSecret?: boolean): string | undefined {
  if (isSecret || !value) return undefined;
  if (target && SECRET_TARGET_RE.test(target)) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || SECRET_VALUE_RE.test(trimmed)) return undefined;
  return trimmed;
}

export class ActionTraceRing {
  #envs = new Map<string, { nextSeq: number; steps: RecordedActionStep[] }>();

  record(
    envId: string,
    input: {
      action: string;
      target?: string;
      value?: string;
      isSecret?: boolean;
      urlBefore: string;
      urlAfter: string;
      netBeforeId: number;
      netAfterId: number;
    },
  ): RecordedActionStep {
    let bucket = this.#envs.get(envId);
    if (!bucket) {
      bucket = { nextSeq: 1, steps: [] };
      this.#envs.set(envId, bucket);
    }
    const seq = bucket.nextSeq;
    bucket.nextSeq += 1;
    const safeValue = sanitizeStepValue(input.value, input.target, input.isSecret);
    const step: RecordedActionStep = {
      stepId: `s${seq}`,
      seq,
      action: input.action,
      ...(input.target ? { target: input.target.slice(0, 120) } : {}),
      ...(safeValue !== undefined ? { value: safeValue } : {}),
      urlBefore: input.urlBefore,
      urlAfter: input.urlAfter,
      netBeforeId: input.netBeforeId,
      netAfterId: input.netAfterId,
      at: new Date().toISOString(),
    };
    bucket.steps.push(step);
    while (bucket.steps.length > MAX_STEPS_PER_ENV) bucket.steps.shift();
    return step;
  }

  list(envId: string): RecordedActionStep[] {
    return [...(this.#envs.get(envId)?.steps ?? [])];
  }

  clear(envId?: string): void {
    if (envId) this.#envs.delete(envId);
    else this.#envs.clear();
  }
}

function isFlowEligibleGet(entry: NetworkEntry): boolean {
  if (entry.method.toUpperCase() !== 'GET') return false;
  if (entry.status < 200 || entry.status >= 300) return false;
  if (!/xhr|fetch|other/i.test(entry.resourceType || 'xhr')) return false;
  if (STATIC_ASSET_RE.test(entry.url)) return false;
  try {
    const u = new URL(entry.url);
    return /^https?:$/i.test(u.protocol);
  } catch {
    return false;
  }
}

function buildSuggestedTemplate(
  rawUrl: string,
  priorInputSteps: readonly RecordedActionStep[],
): {
  suggestedTemplate: string;
  matchedParams: MatchedFlowParam[];
} {
  const u = new URL(rawUrl);
  const base = new URL(`${u.origin}${u.pathname}`);
  const matchedParams: MatchedFlowParam[] = [];
  for (const [k, v] of u.searchParams) {
    if (isSensitiveHeader(k) || isSensitiveKey(k)) continue;
    base.searchParams.set(k, `{{${k}}}`);
    if (v && v.length >= 2) {
      const hit = [...priorInputSteps]
        .reverse()
        .find(
          (s) =>
            s.value && (s.value.toLowerCase() === v.toLowerCase() || v.toLowerCase().includes(s.value.toLowerCase())),
        );
      if (hit) {
        matchedParams.push({ param: k, value: v, sourceStepId: hit.stepId });
      }
    }
  }
  return {
    suggestedTemplate: decodeURIComponent(base.toString()),
    matchedParams,
  };
}

/**
 * 将已录制的动作轨迹与环境遥测网络请求做时间/ID 窗口关联，产出带 `s<N>r<M>` 引用与自动参数线索的候选列表。
 */
export function correlateStepsWithNetwork(
  steps: readonly RecordedActionStep[],
  entries: readonly NetworkEntry[],
): CorrelatedFlowCandidate[] {
  const eligible = entries.filter(isFlowEligibleGet);
  if (eligible.length === 0) return [];

  const out: CorrelatedFlowCandidate[] = [];
  const seenBase = new Set<string>();
  const usedEntryIds = new Set<number>();

  // 1. 先按时间先后遍历已录制的动作步骤，把窗口内的 GET API 绑定为 s<N>r<M>
  const inputHistory: RecordedActionStep[] = [];
  for (const step of steps) {
    if (step.value) inputHistory.push(step);
    const windowReqs = eligible.filter((e) => {
      if (typeof e.id !== 'number') return false;
      return e.id > step.netBeforeId && e.id <= step.netAfterId;
    });
    let rIdx = 0;
    for (const req of windowReqs) {
      rIdx += 1;
      if (typeof req.id === 'number') usedEntryIds.add(req.id);
      let baseKey = req.url;
      try {
        const u = new URL(req.url);
        baseKey = `${u.origin}${u.pathname}`;
      } catch {}
      if (seenBase.has(baseKey)) continue;
      seenBase.add(baseKey);
      const { suggestedTemplate, matchedParams } = buildSuggestedTemplate(req.url, inputHistory);
      const label = [step.action, step.target, step.value ? JSON.stringify(step.value) : ''].filter(Boolean).join(' ');
      out.push({
        ref: `${step.stepId}r${rIdx}`,
        stepId: step.stepId,
        stepLabel: label,
        method: 'GET',
        url: req.url,
        status: req.status,
        resourceType: req.resourceType,
        suggestedTemplate,
        ...(matchedParams.length > 0 ? { matchedParams } : {}),
      });
    }
  }

  // 2. 再补齐未落在动作窗口里的页面初始 GET API（编号 r1, r2...）
  let standaloneIdx = 0;
  for (let i = eligible.length - 1; i >= 0; i -= 1) {
    const req = eligible[i]!;
    if (typeof req.id === 'number' && usedEntryIds.has(req.id)) continue;
    let baseKey = req.url;
    try {
      const u = new URL(req.url);
      baseKey = `${u.origin}${u.pathname}`;
    } catch {}
    if (seenBase.has(baseKey)) continue;
    seenBase.add(baseKey);
    standaloneIdx += 1;
    const { suggestedTemplate, matchedParams } = buildSuggestedTemplate(req.url, inputHistory);
    out.push({
      ref: `r${standaloneIdx}`,
      method: 'GET',
      url: req.url,
      status: req.status,
      resourceType: req.resourceType,
      suggestedTemplate,
      ...(matchedParams.length > 0 ? { matchedParams } : {}),
    });
    if (out.length >= 25) break;
  }

  return out.slice(-25);
}

export const actionTraceRing = new ActionTraceRing();
