/**
 * 浏览器控制层结构化错误构造器（叶子模块，禁止 import 上层模块）。
 */
export interface ErrorDetails {
  hint?: string;
  remedy?: string;
  data?: Record<string, unknown>;
}

export type RichError = Error & {
  code: string;
  details?: ErrorDetails;
};

/** 创建带结构化错误码与可选 `details` 的错误对象。 */
export function richErr(code: string, message: string, details?: ErrorDetails): RichError {
  return Object.assign(new Error(message), {
    code,
    ...(details ? { details } : {}),
  });
}
