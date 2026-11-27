/**
 * 一键证据包。
 *
 * 产出目录固定、结构稳定，便于人复核和 agent 继续分析：
 *   <WARREN_HOME>/evidence/<env>/<timestamp>/
 *     manifest.json
 *     info.json
 *     screenshot.png
 *     snapshot.json
 *     console.json
 *     network.json
 *     net-hits.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { warrenHome } from './paths.ts';
import type { EnvironmentManager } from './environments.ts';

function safeSegment(value: string): string {
  return String(value || 'evidence')
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 80);
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface EvidenceResult {
  dir: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  manifest: Record<string, unknown>;
}

export async function captureEvidence(
  manager: EnvironmentManager,
  environmentId: string,
  options: { name?: string; screenshot?: boolean } = {},
): Promise<EvidenceResult> {
  const environment = manager.get(environmentId);
  if (!environment) {
    throw Object.assign(new Error(`unknown environment ${environmentId}`), { code: 'ENV_NOT_FOUND' });
  }
  const controller = manager.controllerFor(environmentId);
  const dir = path.join(
    warrenHome(),
    'evidence',
    safeSegment(environmentId),
    `${stamp()}${options.name ? `-${safeSegment(options.name)}` : ''}`,
  );
  await mkdir(dir, { recursive: true });
  const files: EvidenceResult['files'] = [];
  const write = async (name: string, value: unknown) => {
    const data =
      typeof value === 'string' || Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2));
    const target = path.join(dir, name);
    await writeFile(target, data);
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    files.push({ path: target, bytes, sha256: sha256(data) });
    return target;
  };
  const existingNetwork = write('network.json', manager.networkEntries(environmentId));
  const existingConsole = write('console.json', manager.consoleEntries(environmentId));
  const existingHits = write('net-hits.json', manager.netHits(environmentId, 100));

  const info = await controller.info();
  const snapshot = await controller.snapshot({ limit: 500 });
  const consoleEntries = manager.consoleEntries(environmentId).slice(-100);
  const networkEntries = manager.networkEntries(environmentId).slice(-100);
  const netHits = manager.netHits(environmentId, 100);
  let screenshotPath: string | undefined;
  if (options.screenshot !== false) {
    const capture = () => controller.screenshot({ path: path.join(dir, 'screenshot.png') });
    const result =
      typeof manager.withScreenshotContext === 'function'
        ? await manager.withScreenshotContext(environmentId, 'agent', capture)
        : await capture();
    screenshotPath = result.path;
    if (result.path) {
      files.push({ path: result.path, bytes: result.bytes, sha256: result.sha256 });
    }
  }
  await write('info.json', info);
  await write('snapshot.json', snapshot);
  await Promise.all([existingNetwork, existingConsole, existingHits]);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    environment: {
      id: environment.id,
      name: environment.name,
      status: environment.status,
      proxy: environment.proxy,
      trustedCa: environment.trustedCa,
      currentUrl: environment.currentUrl,
      title: environment.title,
    },
    info,
    counts: {
      snapshot: snapshot.length,
      console: consoleEntries.length,
      network: networkEntries.length,
      netHits: netHits.length,
    },
    screenshot: screenshotPath ?? null,
    files,
    netRules: manager.netRules(environmentId),
  };
  await write('manifest.json', manifest);
  return { dir, files, manifest };
}
