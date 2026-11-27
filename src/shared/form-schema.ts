/**
 * 声明式表单的校验与裁剪。
 *
 * 这是**信任边界**：插件给的是普通 JSON，主进程在 `overlay:open` 上过一遍这张表才让界面渲染。
 * 渲染层不做二次校验（同一份规则两处实现必然漂移）。
 */
import type { OverlayFormField, OverlayFormOption, OverlayFormRequest } from './types/ui.ts';

export const FORM_LIMITS = {
  fields: 12,
  title: 120,
  description: 400,
  label: 80,
  placeholder: 120,
  submitLabel: 24,
  source: 60,
  text: 2000,
  options: 24,
  optionValue: 120,
} as const;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: 'OVERLAY_FORM_INVALID' });
}

function text(value: unknown, name: string, max: number, { allowEmpty = false } = {}): string {
  if (typeof value !== 'string') bad(`${name} 必须是字符串`);
  if (!allowEmpty && !value.trim()) bad(`${name} 不能为空`);
  if (value.length > max) bad(`${name} 不能超过 ${max} 个字符`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, name, max, { allowEmpty: true });
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${name} 必须是有限数字`);
  return value;
}

function optionalFlag(value: unknown, name: string): true | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') bad(`${name} 必须是布尔值`);
  return value ? true : undefined;
}

function normalizeOptions(raw: unknown, name: string): OverlayFormOption[] {
  if (!Array.isArray(raw) || raw.length === 0) bad(`${name} 至少需要一个选项`);
  if (raw.length > FORM_LIMITS.options) bad(`${name} 最多 ${FORM_LIMITS.options} 个选项`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') bad(`${name} 第 ${index + 1} 个选项不是对象`);
    const option = item as Record<string, unknown>;
    const value = text(option.value, `${name} 第 ${index + 1} 个选项的 value`, FORM_LIMITS.optionValue);
    if (seen.has(value)) bad(`${name} 的 value 重复: ${value}`);
    seen.add(value);
    return { value, label: text(option.label, `${name} 第 ${index + 1} 个选项的 label`, FORM_LIMITS.label) };
  });
}

function normalizeField(raw: unknown, index: number, keys: Set<string>): OverlayFormField {
  const at = `第 ${index + 1} 个字段`;
  if (!raw || typeof raw !== 'object') bad(`${at}不是对象`);
  const field = raw as Record<string, unknown>;
  const key = text(field.key, `${at}的 key`, 32);
  if (!KEY_RE.test(key)) bad(`${at}的 key 必须以字母开头，只能含字母/数字/下划线: ${key}`);
  if (keys.has(key)) bad(`字段 key 重复: ${key}`);
  keys.add(key);
  const label = text(field.label, `${at}的 label`, FORM_LIMITS.label);

  switch (field.type) {
    case 'text':
    case 'textarea': {
      const maxLength = field.maxLength === undefined ? FORM_LIMITS.text : finite(field.maxLength, `${at}的 maxLength`);
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > FORM_LIMITS.text) {
        bad(`${at}的 maxLength 必须是 1..${FORM_LIMITS.text} 的整数`);
      }
      const initial = optionalText(field.initial, `${at}的 initial`, maxLength);
      return {
        key,
        label,
        type: field.type,
        ...(field.placeholder === undefined
          ? {}
          : {
              placeholder: text(field.placeholder, `${at}的 placeholder`, FORM_LIMITS.placeholder, {
                allowEmpty: true,
              }),
            }),
        ...(initial === undefined ? {} : { initial }),
        ...(optionalFlag(field.required, `${at}的 required`) ? { required: true } : {}),
        ...(field.maxLength === undefined ? {} : { maxLength }),
      };
    }
    case 'number': {
      const min = field.min === undefined ? undefined : finite(field.min, `${at}的 min`);
      const max = field.max === undefined ? undefined : finite(field.max, `${at}的 max`);
      if (min !== undefined && max !== undefined && min > max) bad(`${at}的 min 大于 max`);
      const step = field.step === undefined ? undefined : finite(field.step, `${at}的 step`);
      if (step !== undefined && step <= 0) bad(`${at}的 step 必须大于 0`);
      const initial = field.initial === undefined ? undefined : finite(field.initial, `${at}的 initial`);
      if (initial !== undefined && ((min !== undefined && initial < min) || (max !== undefined && initial > max))) {
        bad(`${at}的 initial 超出 min/max`);
      }
      return {
        key,
        label,
        type: 'number',
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(step === undefined ? {} : { step }),
        ...(initial === undefined ? {} : { initial }),
        ...(optionalFlag(field.required, `${at}的 required`) ? { required: true } : {}),
      };
    }
    case 'select': {
      const options = normalizeOptions(field.options, `${at}的 options`);
      const initial = optionalText(field.initial, `${at}的 initial`, FORM_LIMITS.optionValue);
      if (initial !== undefined && !options.some((option) => option.value === initial)) {
        bad(`${at}的 initial 不在 options 里: ${initial}`);
      }
      return { key, label, type: 'select', options, ...(initial === undefined ? {} : { initial }) };
    }
    case 'switch':
      return {
        key,
        label,
        type: 'switch',
        ...(field.description === undefined
          ? {}
          : {
              description: text(field.description, `${at}的 description`, FORM_LIMITS.description, {
                allowEmpty: true,
              }),
            }),
        ...(optionalFlag(field.initial, `${at}的 initial`) ? { initial: true } : {}),
      };
    default:
      return bad(`${at}的 type 不支持: ${String(field.type)}`);
  }
}

/** 校验并裁掉未知字段；调用方拿到的就是可安全渲染的请求。 */
export function normalizeFormRequest(input: unknown): OverlayFormRequest {
  if (!input || typeof input !== 'object') bad('表单请求不是对象');
  const request = input as Record<string, unknown>;
  if (request.kind !== 'form') bad('表单请求的 kind 必须是 form');
  const title = text(request.title, 'title', FORM_LIMITS.title);
  if (!Array.isArray(request.fields) || request.fields.length === 0) bad('fields 至少需要一个字段');
  if (request.fields.length > FORM_LIMITS.fields) bad(`fields 最多 ${FORM_LIMITS.fields} 个字段`);
  const keys = new Set<string>();
  const fields = request.fields.map((field, index) => normalizeField(field, index, keys));
  return {
    kind: 'form',
    title,
    ...(request.description === undefined
      ? {}
      : {
          description: text(request.description, 'description', FORM_LIMITS.description, { allowEmpty: true }),
        }),
    ...(request.submitLabel === undefined
      ? {}
      : { submitLabel: text(request.submitLabel, 'submitLabel', FORM_LIMITS.submitLabel) }),
    ...(request.cancelLabel === undefined
      ? {}
      : { cancelLabel: text(request.cancelLabel, 'cancelLabel', FORM_LIMITS.submitLabel) }),
    ...(optionalFlag(request.destructive, 'destructive') ? { destructive: true } : {}),
    ...(request.source === undefined ? {} : { source: text(request.source, 'source', FORM_LIMITS.source) }),
    fields,
  };
}
