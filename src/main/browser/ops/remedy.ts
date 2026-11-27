/**
 * 结构化错误与自愈命令建议（Remedy）。
 *
 * 原则：
 * 1. 每条 `remedy` 必须是**单条可执行、符合 `bin/commands.mjs` 合法语法**的 `warren ...` 命令，
 *    绝不出现伪命令或过时子命令（单测会用 `validateCliInvocation` 全表防漂移）。
 * 2. 严禁在 `details` / `hint` / `data` 中回显任何密码、Cookie 或 Token 明文。
 */

import type { ErrorDetails } from '../errors.ts';

export interface RemedyContext {
  envId?: string;
  target?: string;
  code?: string;
  reason?: string;
}

/**
 * 为常见错误码补全默认可执行的 `warren ...` 自愈命令和简明提示。
 * 若原错误已经附带更具体的 `details.remedy`，优先保留原值。
 */
export function resolveErrorDetails(error: unknown, ctx: RemedyContext = {}): ErrorDetails | undefined {
  const errObj = error as { code?: string; reason?: string; details?: ErrorDetails } | null | undefined;
  const code = ctx.code ?? errObj?.code ?? '';
  const existing = errObj?.details;
  const env = ctx.envId && /^[\w.-]+$/.test(ctx.envId) ? ctx.envId : '<env>';

  let hint = existing?.hint;
  let remedy = existing?.remedy;
  const data = existing?.data;

  switch (code) {
    case 'CORE_NOT_RUNNING':
      hint ??= 'Warren 桌面核心未运行，启动后再试';
      break;
    case 'ENV_NOT_RUNNING':
      hint ??= `环境 ${env} 尚未启动`;
      remedy ??= `warren env start ${env}`;
      break;
    case 'ENV_NOT_LEASED':
    case 'CONTROL_REVOKED':
      if (errObj?.reason === 'user_takeover') {
        hint ??= '人工已接管 Agent Space，等待交还或加 --wait 重取租约';
        remedy ??= `warren env acquire ${env} --wait=10000`;
      } else {
        hint ??= '写操作需要有效的 Agent Space 租约';
        remedy ??= `warren env acquire ${env}`;
      }
      break;
    case 'DIALOG_OPEN':
      hint ??= '当前存在未处理的原生弹窗，处理前所有输入都会阻塞';
      remedy ??= `warren browser dialog ${env} accept`;
      break;
    case 'TARGET_STALE':
      hint ??= '元素引用已过期（页面导航或局部重绘），请重拍快照获取最新 @ref';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'TARGET_NOT_FOUND':
      hint ??= '未匹配到目标元素，可重拍交互快照或放宽定位器';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'TARGET_AMBIGUOUS':
      hint ??= '命中了多个元素，请改用精确 @ref 或附加 >> nth=0';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'TARGET_OCCLUDED':
      hint ??= '目标被浮层或弹窗遮挡，请先关闭遮挡层（可按 Escape 或检查快照）';
      remedy ??= `warren browser press ${env} Escape`;
      break;
    case 'NOT_ACTIONABLE':
    case 'TARGET_NOT_ACTIONABLE':
      hint ??= '元素当前不可见、被禁用或不是可操作控件，建议先检查快照与状态';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'TARGET_NOT_FILLABLE':
      hint ??= '目标不支持直接输入或选值，请检查控件类型与可用选项';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'ENV_BUSY':
      hint ??= `环境 ${env} 的 Agent Space 当前正被其他调用方或人工接管锁定，可加 --wait 等待释放`;
      remedy ??= `warren env acquire ${env} --wait=10000`;
      break;
    case 'ENV_NOT_VISIBLE':
      hint ??= '页面视图当前被应用内浮层或设置页遮挡，切回环境工作台后再试';
      remedy ??= `warren env list`;
      break;
    case 'TAB_NOT_VISIBLE':
      hint ??= '目标标签不是当前激活标签，请先切换到目标标签再执行输入操作';
      remedy ??= `warren tab list ${env}`;
      break;
    case 'TAB_GONE':
      hint ??= '固定或指定的标签已关闭，禁止静默切到其他标签；请列出并选择新标签';
      remedy ??= `warren tab list ${env}`;
      break;
    case 'FLOW_AUTH_EXPIRED':
      hint ??= '目标站点会话或登录态已失效，请在目标环境中重新登录后再运行 Flow';
      remedy ??= `warren browser info ${env}`;
      break;
    case 'FLOW_RATE_LIMITED':
      hint ??= '接口触发站点频率限制（HTTP 429），请降低请求频率稍后重试';
      remedy ??= `warren flow list`;
      break;
    case 'FLOW_UNKNOWN_FIELD':
      hint ??= '过滤字段名不在返回记录中，请参考报错列出的可用字段名重试';
      remedy ??= `warren flow list`;
      break;
    case 'GRID_EDIT_REJECTED':
      hint ??= '数据表格单元格编辑被校验拒绝并已按 Escape 取消，请检查输入格式后重试';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'SECRET_REJECTED':
      hint ??= '禁止把密码/TOTP/私钥写入 state 或 checkpoint，凭据请改用账号管理插件';
      remedy ??= `warren browser detect-login ${env}`;
      break;
    case 'STATE_TOO_LARGE':
      hint ??= 'exec state 超过体积限制，请用 checkpoint 落盘或清理大数组';
      remedy ??= `warren exec --capabilities`;
      break;
    case 'FILL_UNCONFIRMED':
      hint ??= '输入后回读未匹配期望值，可能被受控组件拦截或焦点偏移，请先检查页面快照';
      remedy ??= `warren browser snapshot ${env} -i`;
      break;
    case 'TIMEOUT':
      hint ??= '等待超时，建议查看当前页面信息与控制台/网络错误';
      remedy ??= `warren browser info ${env}`;
      break;
    default:
      break;
  }

  if (!hint && !remedy && !data) return undefined;
  return {
    ...(hint ? { hint } : {}),
    ...(remedy ? { remedy } : {}),
    ...(data ? { data } : {}),
  };
}

/** 列出所有内置默认模板的 remedy（供防漂移测试逐条用 CLI 校验器验证）。 */
export function sampleBuiltInRemedies(): string[] {
  const codes = [
    'ENV_NOT_RUNNING',
    'ENV_NOT_LEASED',
    'CONTROL_REVOKED',
    'DIALOG_OPEN',
    'TARGET_STALE',
    'TARGET_NOT_FOUND',
    'TARGET_AMBIGUOUS',
    'TARGET_OCCLUDED',
    'NOT_ACTIONABLE',
    'TARGET_NOT_FILLABLE',
    'ENV_BUSY',
    'ENV_NOT_VISIBLE',
    'TAB_NOT_VISIBLE',
    'TAB_GONE',
    'FLOW_AUTH_EXPIRED',
    'FLOW_RATE_LIMITED',
    'FLOW_UNKNOWN_FIELD',
    'GRID_EDIT_REJECTED',
    'SECRET_REJECTED',
    'STATE_TOO_LARGE',
    'FILL_UNCONFIRMED',
    'TIMEOUT',
  ];
  const out: string[] = [];
  for (const code of codes) {
    const details = resolveErrorDetails({ code }, { envId: 'demo' });
    if (details?.remedy) out.push(details.remedy);
  }
  const takeover = resolveErrorDetails({ code: 'CONTROL_REVOKED', reason: 'user_takeover' }, { envId: 'demo' });
  if (takeover?.remedy) out.push(takeover.remedy);
  return out;
}
