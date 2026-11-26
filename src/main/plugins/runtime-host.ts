/**
 * 全权 Node `host` 插件运行时：运行在独立子进程中，可使用完整 Node API，
 * host API 调用仍通过 JSON-RPC 回到主进程接受权限门控。
 */
import { BaseWorkerRuntime, buildWorkerBootstrap } from './runtime-base.ts';

export const HOST_BOOTSTRAP = buildWorkerBootstrap({
  imports: `import { pathToFileURL } from 'node:url';`,
  extraGlobalsExpr: `
globalThis.host = host;
globalThis.log = { debug: writeLog('debug'), info: writeLog('info'), warn: writeLog('warn'), error: writeLog('error') };
`,
  loadEntryBody: `
const loadedModule = await import(pathToFileURL(message.entry).href);
entry = loadedModule.default ?? loadedModule;
`,
});

export class HostRuntime extends BaseWorkerRuntime {
  readonly kind = 'host' as const;

  protected bootstrapSource(): string {
    return HOST_BOOTSTRAP;
  }

  protected bootstrapFilename(): string {
    return 'host-bootstrap.mjs';
  }

  protected async buildInitPayload(): Promise<Record<string, unknown>> {
    return {
      entry: this.entryPath,
    };
  }
}
