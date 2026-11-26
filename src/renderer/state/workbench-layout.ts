import type { DevToolsDockMode } from '../../shared/types.ts';

export const MIN_PAGE_WIDTH_FOR_DUAL_RIGHT = 520;
export const COMPACT_STAGE_WIDTH_THRESHOLD = 1120;

export interface RightPanelBudgetInput {
  stageContainerWidth: number;
  inspectorWidth: number;
  devToolsDock: DevToolsDockMode;
  devToolsSize: number;
}

/**
 * 右侧伴随工作台抽屉与原生 Chrome DevTools（右侧停靠）互斥裁决（方案 1A）：
 * - DevTools 停靠在底部（`bottom`）或独立窗口（`detach`）时允许自由并存；
 * - DevTools 停靠在右侧（`right`）且主舞台偏窄或网页剩余宽度低于 520px 时自动互斥，开一收一。
 */
export function shouldExcludeRightPanels(input: RightPanelBudgetInput): boolean {
  if (input.devToolsDock !== 'right') return false;
  if (!Number.isFinite(input.stageContainerWidth) || input.stageContainerWidth <= 0) return true;
  if (input.stageContainerWidth < COMPACT_STAGE_WIDTH_THRESHOLD) return true;
  return input.stageContainerWidth - input.inspectorWidth - input.devToolsSize < MIN_PAGE_WIDTH_FOR_DUAL_RIGHT;
}
