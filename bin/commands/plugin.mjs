/**
 * 插件管理、脚手架创建与跨插件命令/RPC 调用 CLI 命令组。
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { usageOf } from '../commands.mjs';
import { formatPluginCommandLine, formatPluginLine, formatPluginLogLine, parseJsonArg, print } from '../formatters.mjs';

const execFileAsync = promisify(execFile);

/**
 * 将本地目录来源在 CLI 侧先行 `npm pack` 暂存到 `~/.warren/tmp/`（受管数据目录）：
 * 打包版 macOS `.app` 主进程受 TCC 约束无法直接读取 `~/Documents/` / `~/Desktop/`，
 * 而终端里的 CLI 进程同时拥有终端 TCC 权限与完整 shell PATH。
 */
async function stageLocalPluginSource(rawSource) {
  const trimmed = String(rawSource || '').trim();
  if (!trimmed || trimmed.startsWith('npm:') || trimmed.startsWith('git:')) return null;
  const rawPath = trimmed.startsWith('path:') ? trimmed.slice(5).trim() : trimmed;
  if (!rawPath) return null;
  const absPath = path.resolve(rawPath);
  let info;
  try {
    info = statSync(absPath);
  } catch {
    return null;
  }
  if (!info.isDirectory() || !existsSync(path.join(absPath, 'package.json'))) return null;

  const warrenHome = process.env.WARREN_HOME || path.join(os.homedir(), '.warren');
  const stageDir = path.join(warrenHome, 'tmp', `cli-stage-${randomUUID()}`);
  mkdirSync(stageDir, { recursive: true });
  try {
    const npmCache = path.join(os.tmpdir(), 'warren-npm-cache');
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', stageDir, '--ignore-scripts', '--', absPath],
      {
        cwd: stageDir,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          npm_config_logs_dir: path.join(npmCache, '_logs'),
          npm_config_ignore_scripts: 'true',
        },
      },
    );
    const parsed = JSON.parse(String(stdout));
    const filename = Array.isArray(parsed) && typeof parsed[0]?.filename === 'string' ? parsed[0].filename : '';
    if (!filename) throw new Error('npm pack 未返回归档文件名');
    return {
      stagedSource: `path:${path.join(stageDir, filename)}`,
      displaySource: `path:${absPath}`,
      cleanup: () => rmSync(stageDir, { recursive: true, force: true }),
    };
  } catch {
    rmSync(stageDir, { recursive: true, force: true });
    return null;
  }
}

function scaffoldPlugin(id, name) {
  const packageName = `warren-plugin-${String(id).split('.').at(-1)}`;
  const pkg = {
    name: packageName,
    version: '0.1.0',
    description: `${name} 插件`,
    warren: {
      id,
      name,
      apiVersion: '4',
      runtime: 'sandbox',
      server: 'server.js',
      engines: { warren: '>=0.1.0' },
      permissions: ['environment.read'],
      contributes: {
        commands: [{ name: 'hello', summary: '示例命令：回显当前环境' }],
      },
    },
  };
  const server = `/**
 * ${name} 插件。
 *
 * \`ctx.host\` 上是 host API（受 package.json#warren.permissions 门控），
 * \`ctx.input\` 是 CLI 传进来的 --input，\`ctx.environmentId\` 是当前环境。
 * 完整能力面看 warren 的 docs/PLUGIN-CAPABILITY-DESIGN.md。
 */
module.exports = {
  async activate(ctx) {
    await ctx.host.log.info('${id} activated');
  },

  async hello(ctx) {
    const environments = await ctx.host.environment.list();
    await ctx.host.log.info(\`看到 \${environments.length} 个环境\`);
    return { environmentId: ctx.environmentId ?? null, input: ctx.input ?? null, environments: environments.length };
  },
};
`;
  return { packageJson: JSON.stringify(pkg, null, 2) + '\n', server };
}

async function handlePluginRun({ args, flags, asJson, call }) {
  const id = args[2];
  const command = args[3];
  for (let i = args.length - 1; i >= 2; i -= 1) {
    if (args[i] === '--help' || args[i] === '-h') args.splice(i, 1);
  }
  if (!id || command === '--help' || command === '-h') {
    let plugins = [];
    let offline = '';
    try {
      plugins = await call('plugin.list');
    } catch (error) {
      offline = `（当前连不上 Warren 实例，未列出已安装插件：${error?.code ?? error?.message ?? error}）`;
    }
    if (!id) {
      console.log(offline ? '已安装插件的命令：' + offline : '已安装插件的命令：');
      for (const plugin of plugins) {
        const commands = plugin.contributes?.commands?.length
          ? plugin.contributes.commands.map((item) => item.name).join(', ')
          : '（无）';
        console.log(`  ${plugin.id.padEnd(24)} ${plugin.name.padEnd(20)} ${commands}`);
      }
      console.log('');
      console.log('用法: warren plugin run <id> <command> [--env <环境>] [--input=\'{"k":1}\'] [--lease=<leaseId>]');
      return 0;
    }
  }
  const wantsHelp = Boolean(flags.help) || Boolean(flags.h);
  if (!command || command === '--help' || command === '-h' || wantsHelp) {
    let offline = '';
    const plugins = await call('plugin.list').catch((error) => {
      offline = `（当前连不上 Warren 实例，未能读取插件清单：${error?.code ?? error?.message ?? error}）`;
      return [];
    });
    if (offline) {
      if (wantsHelp && command && command !== '--help' && command !== '-h') {
        console.log(`${id} ${command}`);
        console.log(`  ${offline}\n`);
        console.log(`用法: warren plugin run ${id} ${command} [--env <环境>] [--input='{"k":1}']\n`);
        console.log('（--help 只打印帮助，不执行命令）');
        return 0;
      }
      console.log(`${id}  ${offline}`);
      console.log(`用法: warren plugin run ${id} <command> [--env <环境>] [--input='{"k":1}'] [--lease=<leaseId>]`);
      return command ? 0 : 1;
    }
    const plugin = plugins.find((item) => item.id === id);
    if (!plugin) {
      console.error(`没有插件 ${id}`);
      return 1;
    }
    if (wantsHelp && command && command !== '--help' && command !== '-h') {
      const found = (plugin.contributes?.commands ?? []).find((item) => item.name === command);
      if (!found) {
        console.error(
          `插件 ${id} 没有命令 ${command}；可用：${(plugin.contributes?.commands ?? []).map((c) => c.name).join(', ')}`,
        );
        return 1;
      }
      console.log(`${plugin.id} ${found.name}`);
      console.log(`  ${found.summary ?? ''}\n`);
      console.log(`用法: warren plugin run ${id} ${found.name} [--env <环境>] [--input='{"k":1}']\n`);
      console.log('（--help 只打印帮助，不执行命令）');
      return 0;
    }
    const lines = [
      `${plugin.id} v${plugin.version}  (${plugin.runtime}${plugin.status ? `, ${plugin.status}` : ''})`,
      plugin.description ?? '',
      '',
      '命令:',
      ...(plugin.contributes?.commands?.length
        ? plugin.contributes.commands.map((item) => `  ${item.name.padEnd(20)} ${item.summary}`)
        : ['  （这个插件没有声明命令）']),
      '',
      `用法: warren plugin run ${id} <command> [--env <环境>] [--input='{"k":1}'] [--lease=<leaseId>]`,
    ];
    console.log(lines.filter((line) => line !== undefined).join('\n'));
    return command ? 0 : 1;
  }
  print(
    await call('plugin.run', {
      id,
      command,
      env: typeof flags.env === 'string' ? flags.env : '',
      input: typeof flags.input === 'string' ? parseJsonArg(flags.input, '--input') : undefined,
      leaseId: typeof flags.lease === 'string' ? flags.lease : undefined,
    }),
    asJson,
  );
  return 0;
}

export async function runPluginCommand({ args, flags, asJson, call }) {
  switch (args[1]) {
    case 'list':
      print(await call('plugin.list'), asJson, formatPluginLine);
      return 0;
    case 'install': {
      if (!args[2]) {
        console.error('用法: warren plugin install <path:目录|npm:包名[@版本]|git:仓库#ref>');
        return 1;
      }
      const staged = await stageLocalPluginSource(args[2]);
      try {
        const params = staged
          ? { source: staged.stagedSource, displaySource: staged.displaySource }
          : { source: args[2] };
        print(await call('plugin.install', params), asJson);
      } finally {
        staged?.cleanup();
      }
      return 0;
    }
    case 'update': {
      const id = args[2];
      let staged = null;
      if (id) {
        const list = await call('plugin.list').catch(() => []);
        const current = Array.isArray(list) ? list.find((item) => item?.id === id) : null;
        if (current && typeof current.source === 'string' && current.source.startsWith('path:')) {
          staged = await stageLocalPluginSource(current.source);
        }
      }
      try {
        const params = staged ? { id, stagedSource: staged.stagedSource } : { id };
        print(await call('plugin.update', params), asJson);
      } finally {
        staged?.cleanup();
      }
      return 0;
    }
    case 'create': {
      const id = args[2];
      if (!id || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) {
        console.error('用法: warren plugin create <id> [--dir=路径] [--name=显示名]');
        console.error('  id 只能用小写字母、数字、点、连字符，例如 com.acme.notes');
        return 1;
      }
      const dir = path.resolve(typeof flags.dir === 'string' ? flags.dir : `./${id}`);
      const name = typeof flags.name === 'string' ? flags.name : id;
      if (existsSync(dir)) {
        console.error(`目录已存在，不覆盖: ${dir}`);
        return 1;
      }
      const files = scaffoldPlugin(id, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), files.packageJson);
      writeFileSync(path.join(dir, 'server.js'), files.server);
      console.log(`已生成插件骨架: ${dir}`);
      console.log(`  package.json    id=${id} name=${name}`);
      console.log('  server.js       一个 hello 命令，改它');
      console.log(`下一步: warren plugin install path:${dir} && warren plugin enable ${id}`);
      return 0;
    }
    case 'enable':
      print(await call('plugin.enable', { id: args[2] }), asJson);
      return 0;
    case 'disable':
      print(await call('plugin.disable', { id: args[2] }), asJson);
      return 0;
    case 'uninstall':
      print(await call('plugin.uninstall', { id: args[2] }), asJson);
      return 0;
    case 'grant':
      print(await call('plugin.grant', { id: args[2], permissions: args.slice(3) }), asJson);
      return 0;
    case 'reload':
      print(await call('plugin.reload', { id: args[2] }), asJson);
      return 0;
    case 'status': {
      const plugins = await call('plugin.list');
      const wanted = args[2] ? plugins.filter((plugin) => plugin.id === args[2]) : plugins;
      if (!wanted.length) {
        console.error(`没有插件 ${args[2]}`);
        return 1;
      }
      print(wanted, asJson, formatPluginLine);
      return 0;
    }
    case 'logs':
      print(await call('plugin.logs', { id: args[2], limit: Number(flags.n ?? 50) }), asJson, formatPluginLogLine);
      return 0;
    case 'commands': {
      const plugins = await call('plugin.list');
      const rows = plugins.flatMap((plugin) =>
        (plugin.contributes?.commands ?? []).map((command) => ({
          pluginId: plugin.id,
          plugin: plugin.name,
          enabled: plugin.enabled,
          status: plugin.status,
          name: command.name,
          summary: command.summary,
        })),
      );
      if (!rows.length) {
        console.log('没有插件注册命令。');
        return 0;
      }
      print(rows, asJson, formatPluginCommandLine);
      return 0;
    }
    case 'config':
      if (args[3] === 'set') {
        print(await call('plugin.config.set', { id: args[2], key: args[4], value: args[5] }), asJson);
        return 0;
      }
      print(await call('plugin.list'), asJson, formatPluginLine);
      return 0;
    case 'skill': {
      const id = args[2];
      if (!id) {
        console.error('用法: warren plugin skill <id> [--json]');
        return 1;
      }
      const doc = await call('plugin.readSkill', { id });
      if (asJson) print(doc, true);
      else process.stdout.write(doc.markdown);
      return 0;
    }
    case 'skill-exposure': {
      const id = args[2];
      const rawMode = String(args[3] ?? '').toLowerCase();
      if (!id || !['on', 'off', 'true', 'false'].includes(rawMode)) {
        console.error('用法: warren plugin skill-exposure <id> <on|off>');
        return 1;
      }
      print(await call('plugin.setSkillExposed', { id, exposed: rawMode === 'on' || rawMode === 'true' }), asJson);
      return 0;
    }
    case 'run':
      return handlePluginRun({ args, flags, asJson, call });
    case 'rpc': {
      const id = args[2];
      const method = args[3];
      if (!id || !method) {
        console.error('用法: warren plugin rpc <id> <method> [--input=\'{"k":1}\'] [--lease=<leaseId>] [--env=<环境>]');
        return 1;
      }
      print(
        await call('plugin.rpc', {
          id,
          method,
          input: typeof flags.input === 'string' ? parseJsonArg(flags.input, '--input') : undefined,
          leaseId: typeof flags.lease === 'string' ? flags.lease : undefined,
          environmentId: typeof flags.env === 'string' ? flags.env : undefined,
        }),
        asJson,
      );
      return 0;
    }
    default:
      console.error(usageOf('plugin'));
      return 1;
  }
}
