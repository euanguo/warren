/**
 * 插件安装源。
 *
 * 三种来源最终都变成同一个东西：一个已经 `npm pack` 过的包目录。
 * 这样 path / npm / git 走同一套包校验，开发目录里的 `.git`、构建垃圾、本机状态
 * 不会混进受管插件目录。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { validatePluginPackage, type PluginPackage } from './package.ts';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 180_000;
const NPM_CACHE = path.join(os.tmpdir(), 'warren-npm-cache');

export type PluginSourceKind = 'path' | 'npm' | 'git';

export interface PluginSourceSpec {
  kind: PluginSourceKind;
  /** 去掉前缀后的值 */
  value: string;
  /** 用户原始输入，安装记录里保留这个形状 */
  raw: string;
}

export interface PreparedPlugin {
  /** 已解包、已安装运行时依赖的包目录 */
  dir: string;
  package: PluginPackage;
  source: string;
  /** 实际解析结果：npm 版本 / git commit / 绝对路径 */
  resolved: string;
  /** 临时工作目录，调用方搬走 dir 后删掉 */
  cleanupDir: string;
}

export function parsePluginSource(input: string): PluginSourceSpec {
  const raw = String(input || '').trim();
  if (!raw) throw sourceError('PLUGIN_SOURCE_EMPTY', '安装源不能为空');
  if (raw.startsWith('npm:')) {
    const value = raw.slice(4).trim();
    if (!value) throw sourceError('PLUGIN_SOURCE_INVALID', 'npm: 后面需要包名');
    return { kind: 'npm', value, raw };
  }
  if (raw.startsWith('git:')) {
    const value = raw.slice(4).trim();
    if (!value) throw sourceError('PLUGIN_SOURCE_INVALID', 'git: 后面需要仓库地址');
    return { kind: 'git', value, raw };
  }
  if (raw.startsWith('path:')) {
    const value = raw.slice(5).trim();
    if (!value) throw sourceError('PLUGIN_SOURCE_INVALID', 'path: 后面需要目录');
    return { kind: 'path', value, raw };
  }
  // 裸目录是 CLI 最自然的写法；不是另一套兼容协议。
  return { kind: 'path', value: raw, raw: `path:${raw}` };
}

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  const executable = resolveTool(file);
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_cache: NPM_CACHE,
        npm_config_logs_dir: path.join(NPM_CACHE, '_logs'),
        npm_config_ignore_scripts: 'true',
      },
    });
    return String(result.stdout);
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const detail = String(err.stderr || err.message || err).trim();
    throw sourceError('PLUGIN_SOURCE_COMMAND_FAILED', `${executable} ${args.join(' ')} 失败: ${detail}`);
  }
}

function resolveTool(name: string): string {
  const configured =
    name === 'npm' ? process.env.WARREN_NPM : name === 'git' ? process.env.WARREN_GIT : process.env.WARREN_TAR;
  if (configured && existsSync(configured)) return configured;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  const fallbacks =
    name === 'npm'
      ? [path.join(os.homedir(), '.local/bin/npm'), '/opt/homebrew/bin/npm', '/usr/local/bin/npm']
      : name === 'git'
        ? ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
        : ['/usr/bin/tar', '/bin/tar'];
  const found = fallbacks.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw sourceError(
    `PLUGIN_${name.toUpperCase()}_NOT_FOUND`,
    `找不到 ${name}；设置 ${name === 'npm' ? 'WARREN_NPM' : name === 'git' ? 'WARREN_GIT' : 'WARREN_TAR'} 指向可执行文件`,
  );
}

function sourceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function npmPack(spec: string, destination: string): Promise<{ archive: string; name: string; version: string }> {
  if (spec.startsWith('-')) {
    throw sourceError('PLUGIN_SOURCE_INVALID', `非法的 npm 安装源: ${spec}`);
  }
  const output = await run(
    'npm',
    ['pack', '--json', '--pack-destination', destination, '--ignore-scripts', '--', spec],
    destination,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw sourceError('PLUGIN_SOURCE_BAD_NPM_OUTPUT', `npm pack 没返回 JSON: ${output.slice(0, 500)}`);
  }
  const item = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  const filename = typeof item?.filename === 'string' ? item.filename : '';
  const name = typeof item?.name === 'string' ? item.name : '';
  const version = typeof item?.version === 'string' ? item.version : '';
  if (!filename || !name || !version) {
    throw sourceError('PLUGIN_SOURCE_BAD_NPM_OUTPUT', `npm pack 返回缺字段: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  return { archive: path.join(destination, filename), name, version };
}

async function cloneGit(value: string, destination: string): Promise<{ dir: string; commit: string }> {
  const hashAt = value.lastIndexOf('#');
  const repo = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const ref = hashAt >= 0 ? value.slice(hashAt + 1) : '';
  if (!repo) throw sourceError('PLUGIN_SOURCE_INVALID', 'git: 后面需要仓库地址');
  if (repo.startsWith('-') || /^ext::/i.test(repo)) {
    throw sourceError('PLUGIN_SOURCE_INVALID', `非法的 git 仓库地址: ${repo}`);
  }
  if (ref && ref.startsWith('-')) {
    throw sourceError('PLUGIN_SOURCE_INVALID', `非法的 git ref: ${ref}`);
  }
  await run('git', ['clone', '--depth', '1', '--', repo, destination]);
  if (ref) {
    await run('git', ['fetch', '--depth', '1', '--', 'origin', ref], destination);
    await run('git', ['checkout', '--detach', 'FETCH_HEAD'], destination);
  }
  const commit = (await run('git', ['rev-parse', 'HEAD'], destination)).trim();
  return { dir: destination, commit };
}

async function installRuntimeDependencies(dir: string): Promise<void> {
  const raw = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  if (!raw.dependencies || Object.keys(raw.dependencies).length === 0) return;
  if (
    await stat(path.join(dir, 'node_modules')).then(
      () => true,
      () => false,
    )
  )
    return;
  await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], dir);
}

async function extractArchive(archive: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', destination]);
  const dir = path.join(destination, 'package');
  await stat(path.join(dir, 'package.json')).catch(() => {
    throw sourceError('PLUGIN_SOURCE_BAD_ARCHIVE', `插件包里没有 package.json: ${archive}`);
  });
  return dir;
}

async function prepareFromPack(
  spec: PluginSourceSpec,
  stage: string,
): Promise<{ packageDir: string; resolved: string; cleanup: string }> {
  const work = path.join(stage, 'work');
  await mkdir(work, { recursive: true });

  if (spec.kind === 'path') {
    const sourceDir = path.resolve(spec.value);
    const info = await stat(sourceDir).catch(() => null);
    if (!info?.isDirectory()) throw sourceError('PLUGIN_SOURCE_NOT_FOUND', `插件目录不存在: ${sourceDir}`);
    const packed = await npmPack(sourceDir, work);
    const packageDir = await extractArchive(packed.archive, path.join(stage, 'unpacked'));
    return { packageDir, resolved: sourceDir, cleanup: stage };
  }

  if (spec.kind === 'git') {
    const repo = await cloneGit(spec.value, path.join(stage, 'repo'));
    const packed = await npmPack(repo.dir, work);
    const packageDir = await extractArchive(packed.archive, path.join(stage, 'unpacked'));
    return { packageDir, resolved: repo.commit, cleanup: stage };
  }

  const packed = await npmPack(spec.value, work);
  const packageDir = await extractArchive(packed.archive, path.join(stage, 'unpacked'));
  return { packageDir, resolved: `${packed.name}@${packed.version}`, cleanup: stage };
}

/**
 * 解析、打包、校验、装依赖。
 *
 * 返回的 `dir` 还在临时目录里；调用方必须把它搬进受管目录，然后删掉 `cleanupDir`。
 */
export async function preparePluginSource(input: string, stagingRoot: string): Promise<PreparedPlugin> {
  const spec = parsePluginSource(input);
  await mkdir(stagingRoot, { recursive: true });
  const stage = path.join(stagingRoot, `source-${crypto.randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    const prepared = await prepareFromPack(spec, stage);
    const raw = JSON.parse(await readFile(path.join(prepared.packageDir, 'package.json'), 'utf8'));
    const validation = validatePluginPackage(raw);
    if (!validation.ok || !validation.package) {
      throw sourceError('PLUGIN_PACKAGE_INVALID', validation.errors.join('; '));
    }
    await installRuntimeDependencies(prepared.packageDir);
    return {
      dir: prepared.packageDir,
      package: validation.package,
      source: spec.kind === 'path' ? `path:${path.resolve(spec.value)}` : `${spec.kind}:${spec.value}`,
      resolved: prepared.resolved,
      cleanupDir: prepared.cleanup,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** 安装时把包目录搬到受管目录；分开写是为了让 host 能在 rename 失败时自己回滚。 */
export async function movePreparedPlugin(prepared: PreparedPlugin, target: string): Promise<void> {
  await cp(prepared.dir, target, { recursive: true, force: false, errorOnExist: true });
}

export async function cleanupPreparedPlugin(prepared: PreparedPlugin): Promise<void> {
  await rm(prepared.cleanupDir, { recursive: true, force: true });
}
