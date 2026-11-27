/**
 * 原子输出缓冲与 Hard-Stop 净化器（借鉴 Ego Browser `output-sink.ts`）：
 * - 普通执行正常刷出全量日志与结果；
 * - 一旦遇到不可继续的硬中止（人工接管、租约丢失、跨 Space 越权、阻塞原生弹窗），
 *   丢弃前序可能误导 AI 的半成功业务输出，只发出一条权威中止说明与可执行 `remedy`。
 */
import { stripTerminalEscapes } from './output-guard.mjs';

export const HARD_STOP_ERROR_CODES = new Set(['CONTROL_REVOKED', 'ENV_BUSY', 'SPACE_FORBIDDEN', 'DIALOG_OPEN']);

export function isHardStopError(errorOrCode) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code;
  return typeof code === 'string' && HARD_STOP_ERROR_CODES.has(code);
}

export function formatHardStopMessage(error, meta = {}) {
  const code = error?.code ?? 'HARD_STOP';
  const msg = stripTerminalEscapes(String(error?.message ?? error));
  const stepNote =
    typeof meta.completedSteps === 'number' && meta.completedSteps > 0
      ? `（前 ${meta.completedSteps} 步已派发，页面可能已发生部分变化；请勿盲目重放写操作）`
      : '';
  const lines = [`[HARD-STOP] ${code}: ${msg}${stepNote}`];
  const hint = error?.details?.hint;
  const remedy = error?.details?.remedy;
  if (hint) lines.push(`  提示: ${stripTerminalEscapes(hint)}`);
  if (remedy) lines.push(`  建议: ${stripTerminalEscapes(remedy)}`);
  return lines.join('\n');
}

export function createOutputBuffer() {
  const chunks = [];
  let hardStop = null;
  let flushed = false;

  return {
    push(chunk) {
      if (hardStop !== null) return;
      chunks.push(String(chunk));
    },
    markHardStop(error, meta = {}) {
      if (hardStop === null) {
        hardStop = formatHardStopMessage(error, meta);
      }
    },
    isHardStopped() {
      return hardStop !== null;
    },
    render() {
      if (hardStop !== null) return hardStop;
      return chunks.join('');
    },
    flush(write = (text) => process.stdout.write(text)) {
      if (flushed) return;
      flushed = true;
      const out = hardStop !== null ? `${hardStop}\n` : chunks.join('');
      if (out) write(out);
    },
  };
}
