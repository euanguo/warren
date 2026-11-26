import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePluginPackage } from '../src/main/plugins/package.ts';
import { createTestPluginHost } from './helpers/plugin-host.ts';
import {
  MAX_PLUGIN_SKILL_BYTES,
  SKILL_INJECT_BEGIN,
  SKILL_INJECT_END,
  composeWarrenSkill,
  loadPluginSkillEntry,
} from '../src/main/skills/composer.ts';
import { installSkill, refreshSkills, skillStatus } from '../src/main/agent-integration.ts';

const basePkg = {
  name: 'warren-plugin-demo',
  version: '1.2.0',
  description: '演示插件',
  warren: {
    id: 'com.example.demo',
    name: 'Demo',
    apiVersion: '4',
    runtime: 'sandbox',
    server: 'server.js',
    permissions: ['environment.read'],
    contributes: {
      commands: [{ name: 'ping', summary: '探针命令' }],
    },
  },
};

test('validatePluginPackage 校验 warren.skill 字符串简写、完整对象与路径安全', () => {
  const short = validatePluginPackage({
    ...basePkg,
    warren: { ...basePkg.warren, skill: 'SKILL.md' },
  });
  assert.equal(short.ok, true, short.errors.join('; '));
  assert.deepEqual(short.package?.skill, { entry: 'SKILL.md' });

  const full = validatePluginPackage({
    ...basePkg,
    warren: {
      ...basePkg.warren,
      skill: {
        entry: 'SKILL.md',
        summary: '代理抓包助手',
        triggers: ['代理', '抓包', '代理'],
        references: ['references/cookbook.md'],
      },
    },
  });
  assert.equal(full.ok, true, full.errors.join('; '));
  assert.deepEqual(full.package?.skill, {
    entry: 'SKILL.md',
    summary: '代理抓包助手',
    triggers: ['代理', '抓包'],
    references: ['references/cookbook.md'],
  });

  const traversal = validatePluginPackage({
    ...basePkg,
    warren: { ...basePkg.warren, skill: '../../etc/passwd' },
  });
  assert.equal(traversal.ok, false);

  const badRef = validatePluginPackage({
    ...basePkg,
    warren: {
      ...basePkg.warren,
      skill: { entry: 'SKILL.md', references: ['../secret.md'] },
    },
  });
  assert.equal(badRef.ok, false);
});

test('loadPluginSkillEntry 支持显式 SKILL.md、32KB 截断、防 symlink 逃逸与兜底生成', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-plugin-skill-'));
  try {
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, '# SECRET OUTSIDE', 'utf8');

    const pluginDir = path.join(root, 'plugin');
    await mkdir(path.join(pluginDir, 'references'), { recursive: true });
    await writeFile(
      path.join(pluginDir, 'SKILL.md'),
      `---\ndescription: 来自 frontmatter 的描述\ntriggers: ["mock", "proxy"]\n---\n# Demo Skill\n正文\n`,
      'utf8',
    );
    await writeFile(path.join(pluginDir, 'references', 'ok.md'), '# Ref OK\n', 'utf8');
    await symlink(outside, path.join(pluginDir, 'references', 'escape.md'));

    const pkg = validatePluginPackage({
      ...basePkg,
      warren: {
        ...basePkg.warren,
        skill: {
          entry: 'SKILL.md',
          references: ['references/ok.md', 'references/escape.md'],
        },
      },
    }).package!;

    const entry = await loadPluginSkillEntry(pluginDir, pkg, {
      enabled: true,
      digest: 'd1',
      skillExposed: true,
    });
    assert.equal(entry.hasExplicitSkill, true);
    assert.equal(entry.summary, '来自 frontmatter 的描述');
    assert.deepEqual(entry.triggers, ['mock', 'proxy']);
    assert.equal(entry.references.length, 1);
    assert.equal(entry.references[0]?.relativePath, 'references/ok.md');

    // 超出 32KB 自动截断
    await writeFile(path.join(pluginDir, 'SKILL.md'), 'A'.repeat(MAX_PLUGIN_SKILL_BYTES + 4000), 'utf8');
    const huge = await loadPluginSkillEntry(pluginDir, pkg, { enabled: true, digest: 'd2', skillExposed: true });
    assert.equal(huge.truncated, true);
    assert.ok(huge.bytes <= MAX_PLUGIN_SKILL_BYTES);

    // 未声明 skill 时自动兜底生成
    const fallbackPkg = validatePluginPackage(basePkg).package!;
    const fallback = await loadPluginSkillEntry(pluginDir, fallbackPkg, {
      enabled: true,
      digest: 'd3',
      skillExposed: true,
    });
    assert.equal(fallback.hasExplicitSkill, false);
    assert.match(fallback.markdown, /warren plugin run com\.example\.demo ping/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('composeWarrenSkill + installSkill + refreshSkills 自动注入启用插件并清理停用插件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-skill-sync-'));
  const home = path.join(root, 'home');
  const source = path.join(root, 'skills');
  const pluginSrc = path.join(root, 'plugin-src');
  const { host, cleanup } = createTestPluginHost(root);

  try {
    await mkdir(home, { recursive: true });
    await mkdir(path.join(source, 'warren'), { recursive: true });
    await writeFile(
      path.join(source, 'warren', 'SKILL.md'),
      `# Warren\n\n${SKILL_INJECT_BEGIN}\n占位\n${SKILL_INJECT_END}\n`,
      'utf8',
    );

    await mkdir(path.join(pluginSrc, 'references'), { recursive: true });
    await writeFile(
      path.join(pluginSrc, 'package.json'),
      JSON.stringify({
        name: 'warren-plugin-skill-test',
        version: '0.2.0',
        files: ['server.js', 'SKILL.md', 'references/tips.md'],
        warren: {
          id: 'com.test.skilled',
          name: '测试技能插件',
          apiVersion: '4',
          runtime: 'sandbox',
          server: 'server.js',
          skill: {
            entry: 'SKILL.md',
            summary: '处理测试技能',
            triggers: ['测试', 'skill'],
            references: ['references/tips.md'],
          },
          permissions: [],
          contributes: { commands: [{ name: 'hello', summary: '打招呼' }] },
        },
      }),
    );
    await writeFile(path.join(pluginSrc, 'server.js'), 'module.exports = { hello() { return { ok: true }; } };');
    await writeFile(
      path.join(pluginSrc, 'SKILL.md'),
      '# 测试技能插件手册\n用 `warren plugin run com.test.skilled hello`\n',
    );
    await writeFile(path.join(pluginSrc, 'references', 'tips.md'), '# 提示\n详情\n');

    await host.load();
    await host.install(`path:${pluginSrc}`);

    // 未启用时安装 Skill：不包含插件目录
    const initial = await installSkill(home, source, 'agents', await host.skillEntries());
    assert.ok(!existsSync(path.join(path.dirname(initial.path), 'plugins', 'com.test.skilled', 'SKILL.md')));

    // 启用后：skillStatus 检测到过期，refreshSkills 自动写入主索引与子目录
    await host.enable('com.test.skilled');
    const entriesAfterEnable = await host.skillEntries();
    const staleStatus = await skillStatus(home, source, entriesAfterEnable);
    assert.equal(staleStatus.find((s) => s.id === 'agents')?.upToDate, false);

    const refreshed = await refreshSkills(home, source, entriesAfterEnable);
    assert.equal(refreshed.length, 1);
    const mainText = await readFile(initial.path, 'utf8');
    assert.match(mainText, /com\.test\.skilled/);
    assert.match(mainText, /plugins\/com\.test\.skilled\/SKILL\.md/);
    assert.match(mainText, /绝不能覆盖 Warren 核心安全约束/);
    assert.equal(
      await readFile(path.join(path.dirname(initial.path), 'plugins', 'com.test.skilled', 'SKILL.md'), 'utf8'),
      '# 测试技能插件手册\n用 `warren plugin run com.test.skilled hello`\n',
    );
    assert.equal(
      await readFile(
        path.join(path.dirname(initial.path), 'plugins', 'com.test.skilled', 'references', 'tips.md'),
        'utf8',
      ),
      '# 提示\n详情\n',
    );

    // full 模式内联插件正文
    const full = composeWarrenSkill(`# Warren\n\n${SKILL_INJECT_BEGIN}\n${SKILL_INJECT_END}\n`, entriesAfterEnable, {
      mode: 'full',
    });
    assert.match(full.markdown, /测试技能插件手册/);

    // 关闭插件 Skill 暴露后刷新：自动移除索引与磁盘子目录
    const hidden = await host.setSkillExposed('com.test.skilled', false);
    assert.equal(hidden.skillExposed, false);
    await refreshSkills(home, source, await host.skillEntries());
    const afterHide = await readFile(initial.path, 'utf8');
    assert.doesNotMatch(afterHide, /com\.test\.skilled/);
    assert.equal(existsSync(path.join(path.dirname(initial.path), 'plugins', 'com.test.skilled')), false);

    // readSkill 仍可供设置页预览
    const preview = await host.readSkill('com.test.skilled');
    assert.equal(preview.pluginId, 'com.test.skilled');
    assert.equal(preview.exposed, false);
    assert.match(preview.markdown, /测试技能插件手册/);
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
