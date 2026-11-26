import { app } from 'electron';
import { createServer, type Server } from 'node:net';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentManager } from './environments';
import type { PluginHost } from './plugins/host';
import type { Store } from './store';
import type { VaultStore } from './vault/store';
import type { LeaseDenialReason, RpcErrorDetails, RpcRequest, RpcResponse } from '../shared/types';
import { dispatchRpc, RpcError, type DispatchDeps } from './rpc-dispatch.ts';
import { resolveErrorDetails } from './browser/ops/remedy.ts';
import { warrenPaths } from './paths.ts';

// 运行时文件也归数据根管（以前是 `~/.warren` 根下）。见 src/main/paths.ts。
export const RUNTIME_DIR = warrenPaths().runtime;
export const SOCKET_PATH = path.join(RUNTIME_DIR, 'envd.sock');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

export interface RpcDeps {
  vault: VaultStore;
  saveVault: () => Promise<void>;
  plugins: PluginHost;
  skillSourceDir?: string;
  homeDir?: string;
}

export class RpcServer {
  #dispatchDeps: DispatchDeps;
  #token: string;
  #server?: Server;

  constructor(manager: EnvironmentManager, store: Store, deps: RpcDeps) {
    this.#dispatchDeps = {
      manager,
      store,
      vault: deps.vault,
      saveVault: deps.saveVault,
      plugins: deps.plugins,
      skillSourceDir: deps.skillSourceDir,
      homeDir: deps.homeDir,
      isPackaged: app.isPackaged,
      allowWindowCommands: process.env.WARREN_ALLOW_WINDOW_COMMANDS === '1',
      quit: () => app.quit(),
    };
    this.#token = crypto.randomUUID();
  }

  async listen(): Promise<void> {
    await mkdir(RUNTIME_DIR, { recursive: true });
    await unlink(SOCKET_PATH).catch(() => {});

    this.#server = createServer((socket) => {
      let buffer = '';
      socket.on('data', async (chunk) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const response = await this.#handle(line);
          socket.write(JSON.stringify(response) + '\n');
        }
      });
      socket.on('error', () => socket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(SOCKET_PATH, () => resolve());
    });
    await chmod(SOCKET_PATH, 0o600);
    await writeFile(
      RUNTIME_FILE,
      JSON.stringify({ socketPath: SOCKET_PATH, token: this.#token, pid: process.pid }, null, 2) + '\n',
      {
        mode: 0o600,
      },
    );
  }

  async #handle(line: string): Promise<RpcResponse> {
    let request: RpcRequest & { token?: string };
    try {
      request = JSON.parse(line);
    } catch {
      return { id: 'unknown', ok: false, error: { code: 'BAD_REQUEST', message: 'invalid JSON' } };
    }
    try {
      if (request.token !== this.#token) throw new RpcError('UNAUTHORIZED', 'invalid token');
      const result = await dispatchRpc(this.#dispatchDeps, request.method, request.params ?? {});
      return { id: request.id, ok: true, result };
    } catch (error) {
      const err = error as Error & {
        code?: string;
        reason?: LeaseDenialReason;
        expiredAt?: number;
        details?: RpcErrorDetails;
      };
      const envId = typeof request.params?.id === 'string' ? request.params.id : undefined;
      const details = resolveErrorDetails(err, { envId, code: err.code ?? 'INTERNAL', reason: err.reason });
      return {
        id: request.id,
        ok: false,
        error: {
          code: err.code ?? 'INTERNAL',
          message: err.message,
          retryable: err.code === 'ENV_BUSY',
          ...(err.reason ? { reason: err.reason } : {}),
          ...(err.expiredAt === undefined ? {} : { expiredAt: err.expiredAt }),
          ...(details ? { details } : {}),
        },
      };
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    await unlink(SOCKET_PATH).catch(() => {});
    await unlink(RUNTIME_FILE).catch(() => {});
  }
}
