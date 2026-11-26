// ---------------------------------------------------------------------------
// 跨类型子模块共享的基础原语类型（叶子模块，禁止 import 任何其他 shared/types/*）
// ---------------------------------------------------------------------------

/** 谁建的这个环境。 */
export type Creator = 'human' | 'agent';

/** 环境级审批策略。`inherit` = 跟随全局。 */
export type ApprovalMode = 'inherit' | 'ask' | 'auto';

export type ControlOwner = 'none' | 'agent' | 'human';

export type SpaceId = 'person' | 'agent';

export type EnvironmentStatus = 'stopped' | 'starting' | 'running' | 'dormant' | 'error';

export type DevToolsDockMode = 'right' | 'bottom' | 'detach';

export type ViewportPresetId = 'auto' | 'desktop-1440' | 'laptop-1280' | 'mobile-390';

export type BuiltinSettingsSection = 'general' | 'browser' | 'agent' | 'vault' | 'plugins' | 'diagnostics';

/**
 * 页面视图的矩形。原生视图不遵守 DOM 布局，位置只能由渲染层实测后报给主进程。
 */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
