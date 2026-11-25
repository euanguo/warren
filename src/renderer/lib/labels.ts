import type { ControlOwner } from '@shared/types';
import type { StatusDotTone } from '@/components/ui/status-dot';

/** 控制权归属的中文展示。渲染层专用，不跨进程。 */
export const ownerLabel: Record<ControlOwner, string> = {
  none: '空闲',
  agent: 'AI 操作中',
  human: '人工接管中',
};

/** 环境运行状态的中文展示。 */
export const statusLabel: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  dormant: '休眠中',
  error: '出错',
};

/** 环境状态 → 状态点色调。领域词到展示词的映射只放这里，UI 组件不认识 Environment。 */
export function statusTone(status: string): StatusDotTone {
  if (status === 'error') return 'error';
  if (status === 'running') return 'success';
  if (status === 'dormant') return 'warning';
  if (status === 'starting') return 'warning';
  return 'idle';
}
