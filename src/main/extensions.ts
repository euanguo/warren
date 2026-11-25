/**
 * 每环境的 Chrome 扩展（解包目录）。
 *
 * **状态就是文件系统**：扩展放在 `<环境 storagePath>/extensions/<name>/`，不另存一张表 ——
 * 环境目录本来就是「这个环境的全部状态」，扩展是其中一部分（和 Cookie / localStorage 同理）。
 *
 * Electron 的三条硬约束（读 `electron.d.ts` 得到，不是猜的）：
 * 1. **不支持 `.crx`** —— 必须是解包后的目录，所以 `add` 要校验目录里有 `manifest.json`；
 * 2. `loadExtension` 不能在 `app.ready` 之前调（我们在 `start()` 里调，早过了）；
 * 3. 不支持 in-memory session —— Warren 用 `session.fromPath` 的**持久 session**，不受影响。
 *
 * 纯逻辑 + 显式路径参数（不 import electron），所以能拿临时目录直接单测。
 */
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** 扩展目录名不许带路径分隔符或 `..`，否则 `add` 能写到 storagePath 外面去。 */
export function safeExtensionName(raw: string): string {
  const name = raw.trim();
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || name.startsWith('.')) {
    throw Object.assign(new Error(`扩展名不合法: ${raw}`), { code: 'BAD_EXTENSION_NAME' });
  }
  return name;
}

export function extensionsRoot(storagePath: string): string {
  return path.join(storagePath, 'extensions');
}

/** 校验一个目录是不是**解包好的**扩展。`.crx` 文件、缺 manifest 的目录都在这里被挡掉。 */
export async function assertUnpackedExtension(dir: string): Promise<{ name: string; version: string }> {
  const info = await stat(dir).catch(() => null);
  if (!info) throw Object.assign(new Error(`目录不存在: ${dir}`), { code: 'EXTENSION_NOT_FOUND' });
  if (!info.isDirectory()) {
    throw Object.assign(
      new Error(`${dir} 不是目录。Electron 不支持 .crx，请先解包成目录（unzip 之后删掉最外层的 _metadata）`),
      { code: 'EXTENSION_NOT_UNPACKED' },
    );
  }
  const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => null);
  if (!raw) throw Object.assign(new Error(`${dir} 里没有 manifest.json`), { code: 'EXTENSION_NO_MANIFEST' });
  let manifest: { manifest_version?: unknown; name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`${dir}/manifest.json 不是合法 JSON`), { code: 'EXTENSION_BAD_MANIFEST' });
  }
  for (const key of ['manifest_version', 'name', 'version'] as const) {
    if (manifest[key] === undefined) {
      throw Object.assign(new Error(`${dir}/manifest.json 缺 ${key}`), { code: 'EXTENSION_BAD_MANIFEST' });
    }
  }
  return { name: String(manifest.name), version: String(manifest.version) };
}

/** 该环境装了哪些扩展。目录不存在就是没装（不报错）。 */
export async function listExtensions(storagePath: string): Promise<{ id: string; dir: string }[]> {
  const root = extensionsRoot(storagePath);
  const names = await readdir(root).catch(() => [] as string[]);
  const out: { id: string; dir: string }[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    if ((await stat(dir).catch(() => null))?.isDirectory()) out.push({ id: name, dir });
  }
  return out;
}

/** 把一个解包好的扩展拷进环境。同名会**覆盖**（换版本就是这条路）。 */
export async function addExtension(
  storagePath: string,
  srcDir: string,
  name?: string,
): Promise<{ id: string; dir: string }> {
  await assertUnpackedExtension(srcDir);
  const id = safeExtensionName(name ?? path.basename(path.resolve(srcDir)));
  const dir = path.join(extensionsRoot(storagePath), id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(srcDir, dir, { recursive: true });
  return { id, dir };
}

export async function removeExtension(storagePath: string, name: string): Promise<boolean> {
  const id = safeExtensionName(name);
  const dir = path.join(extensionsRoot(storagePath), id);
  if (!(await stat(dir).catch(() => null))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
