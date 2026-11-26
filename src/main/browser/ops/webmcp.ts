/**
 * WebMCP 发现与调用：探测页面声明的 `navigator.modelContext` 工具清单并按名执行。
 *
 * 安全约束：
 * - 页面提供的工具名、描述与返回值均属**不可信内容（untrusted）**；
 * - 描述字段长度强制截断（<= 200 字符），且移除终端转义字符，防止借描述实施提示注入；
 * - `callWebMcpTool` 必须经由 RPC 写门控（需要有效 Agent Space 租约）。
 */
import type { PageContext } from '../ctx.ts';
import { richErr } from '../errors.ts';
import { redactSecrets } from '../redact.ts';
import { withTimeout } from '../timeout.ts';
import { stripTerminalEscapes } from '../../../../bin/output-guard.mjs';

const WEBMCP_CALL_TIMEOUT_MS = 15_000;

export interface WebMcpToolSummary {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  untrusted: true;
}

const DISCOVER_WEBMCP_SCRIPT = `(() => {
  const results = [];
  const pushTool = (t) => {
    if (!t || typeof t !== 'object') return;
    const name = String(t.name || '').trim();
    if (!name) return;
    results.push({
      name: name.slice(0, 80),
      description: String(t.description || '').slice(0, 200),
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : undefined,
    });
  };
  const mc = navigator.modelContext || window.__webmcp || window.__modelContext;
  if (mc) {
    if (typeof mc.listTools === 'function') {
      try {
        const list = mc.listTools();
        if (Array.isArray(list)) list.forEach(pushTool);
      } catch {}
    } else if (Array.isArray(mc.tools)) {
      mc.tools.forEach(pushTool);
    } else if (mc.tools instanceof Map) {
      for (const t of mc.tools.values()) pushTool(t);
    }
  }
  // 同时兼容声明式 <form toolname="..."> WebMCP 草案约定
  for (const form of document.querySelectorAll('form[toolname]')) {
    const name = (form.getAttribute('toolname') || '').trim();
    if (!name) continue;
    const properties = {};
    for (const field of form.querySelectorAll('input[name], select[name], textarea[name]')) {
      const fn = field.getAttribute('name');
      if (!fn) continue;
      properties[fn] = {
        type: 'string',
        description: String(field.getAttribute('tooldescription') || field.getAttribute('placeholder') || '').slice(0, 120),
      };
    }
    results.push({
      name: name.slice(0, 80),
      description: String(form.getAttribute('tooldescription') || '').slice(0, 200),
      inputSchema: { type: 'object', properties },
    });
  }
  return results.slice(0, 32);
})()`;

/** 列出当前页面声明的 WebMCP 工具（只读）。 */
export async function listWebMcpTools(ctx: PageContext): Promise<{
  supported: boolean;
  untrusted: true;
  tools: WebMcpToolSummary[];
}> {
  const res = await ctx
    .send<{ result?: { value?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> } }>(
      'Runtime.evaluate',
      {
        expression: DISCOVER_WEBMCP_SCRIPT,
        returnByValue: true,
        awaitPromise: true,
      },
    )
    .catch(() => null);
  const raw = Array.isArray(res?.result?.value) ? res.result.value : [];
  const tools: WebMcpToolSummary[] = raw.map((t) => ({
    name: stripTerminalEscapes(String(t.name)).slice(0, 80),
    description: stripTerminalEscapes(String(t.description ?? '')).slice(0, 200),
    ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
    untrusted: true,
  }));
  return { supported: tools.length > 0, untrusted: true, tools };
}

/** 调用页面声明的指定 WebMCP 工具（写操作，需租约门控）。 */
export async function callWebMcpTool(
  ctx: PageContext,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; tool: string; untrusted: true; result: unknown }> {
  const cleanName = toolName.trim();
  if (!cleanName) throw richErr('BAD_REQUEST', 'webmcp call 需要指定工具名');
  const res = await withTimeout(
    ctx.send<{
      result?: { value?: { ok?: boolean; result?: unknown; error?: string } };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression: `(async () => {
      const name = ${JSON.stringify(cleanName)};
      const args = ${JSON.stringify(args ?? {})};
      const mc = navigator.modelContext || window.__webmcp || window.__modelContext;
      if (mc) {
        if (typeof mc.callTool === 'function') {
          return { ok: true, result: await mc.callTool(name, args) };
        }
        if (typeof mc.executeTool === 'function') {
          return { ok: true, result: await mc.executeTool(name, args) };
        }
        const list = Array.isArray(mc.tools) ? mc.tools : mc.tools instanceof Map ? [...mc.tools.values()] : [];
        const found = list.find((t) => t && t.name === name);
        if (found && typeof found.execute === 'function') {
          return { ok: true, result: await found.execute(args) };
        }
      }
      // 声明式 form[toolname]
      const form = document.querySelector('form[toolname=' + JSON.stringify(name) + ']');
      if (form) {
        for (const [k, v] of Object.entries(args)) {
          const el = form.querySelector('[name=' + JSON.stringify(k) + ']');
          if (el && 'value' in el) {
            el.value = String(v ?? '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return { ok: true, result: { submittedForm: name } };
      }
      return { ok: false, error: '页面未注册 WebMCP 工具: ' + name };
    })()`,
      returnByValue: true,
      awaitPromise: true,
    }),
    WEBMCP_CALL_TIMEOUT_MS,
    `WebMCP 工具 ${cleanName} 执行超时（>${WEBMCP_CALL_TIMEOUT_MS}ms）`,
  );
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown';
    throw richErr('BAD_REQUEST', `WebMCP 工具调用异常: ${stripTerminalEscapes(String(msg)).slice(0, 200)}`);
  }
  const value = res.result?.value;
  if (!value?.ok) {
    throw richErr('TARGET_NOT_FOUND', value?.error ?? `未找到 WebMCP 工具: ${cleanName}`);
  }
  return { ok: true, tool: cleanName, untrusted: true, result: redactSecrets(value.result).value };
}
