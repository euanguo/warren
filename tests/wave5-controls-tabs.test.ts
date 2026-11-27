import assert from 'node:assert/strict';
import test from 'node:test';
import { runAction } from '../src/main/browser/actionability.ts';
import { matchAriaOption, normalizeAriaSelectWants } from '../src/main/browser/form-actions.ts';
import { resolveErrorDetails, sampleBuiltInRemedies } from '../src/main/browser/ops/remedy.ts';
import { TabList, closeAgentOnlySet } from '../src/main/domain/tabs.ts';
import { validateCliInvocation } from '../bin/commands.mjs';

test('TabList 支持稳定短引用 t1/t2 解析，且 closeAgentOnlySet 不误删人工标签', () => {
  const list = new TabList();
  list.add(
    {
      id: 'u1',
      space: 'agent',
      shortRef: 't1',
      openedBy: 'human',
      title: 'Home',
      url: 'https://a.test',
      loading: false,
      audible: false,
      muted: false,
      createdAt: '1',
    },
    { activate: true },
  );
  list.add(
    {
      id: 'u2',
      space: 'agent',
      shortRef: 't2',
      openedBy: 'agent',
      title: 'Sub',
      url: 'https://a.test/2',
      loading: false,
      audible: false,
      muted: false,
      createdAt: '2',
    },
    { activate: false },
  );
  list.add(
    {
      id: 'u3',
      space: 'agent',
      shortRef: 't3',
      openedBy: 'popup',
      title: 'Pop',
      url: 'https://a.test/3',
      loading: false,
      audible: false,
      muted: false,
      createdAt: '3',
    },
    { activate: false },
  );

  assert.equal(list.resolve('t2'), 'u2');
  assert.equal(list.resolve('T3'), 'u3');

  // 关掉 t2 后，t3 依然稳定指向 u3（不会像数字序号一样飘移）
  list.remove('u2');
  assert.equal(list.resolve('t3'), 'u3');
  assert.equal(list.resolve('t2'), undefined);

  // 混合 human + popup 时只关闭 popup
  assert.deepEqual(closeAgentOnlySet(list.list, list.activeId), ['u3']);

  // 全是 agent 打开时保留当前激活标签，避免误停环境
  const allAgent = [
    {
      id: 'a1',
      space: 'agent' as const,
      shortRef: 't1',
      openedBy: 'agent' as const,
      title: '1',
      url: 'https://a.test',
      loading: false,
      audible: false,
      muted: false,
      createdAt: '1',
    },
    {
      id: 'a2',
      space: 'agent' as const,
      shortRef: 't2',
      openedBy: 'agent' as const,
      title: '2',
      url: 'https://b.test',
      loading: false,
      audible: false,
      muted: false,
      createdAt: '2',
    },
  ];
  assert.deepEqual(closeAgentOnlySet(allAgent, 'a2'), ['a1']);
});

test('normalizeAriaSelectWants 与 matchAriaOption 支持多值 chip 选择与歧义拦截', () => {
  assert.deepEqual(normalizeAriaSelectWants(['urgent', { label: 'frontend' }, { value: 'p0' }]), [
    'urgent',
    'frontend',
    'p0',
  ]);

  const options = [
    { label: 'Frontend Core', value: 'fe-core' },
    { label: 'Frontend UI', value: 'fe-ui' },
    { label: 'Backend', value: 'be' },
  ];
  // 精确匹配直接命中
  assert.equal(matchAriaOption(options, 'Backend').status, 'hit');
  // 唯一子串匹配直接命中
  assert.equal(matchAriaOption(options, 'Core').status, 'hit');
  // 多个子串模糊命中必须报 ambiguous，绝不盲点第一个
  const amb = matchAriaOption(options, 'Frontend');
  assert.equal(amb.status, 'ambiguous');
  if (amb.status === 'ambiguous') assert.equal(amb.matches.length, 2);
  // 未命中报 not_found
  assert.equal(matchAriaOption(options, 'DevOps').status, 'not_found');
});

test('runAction 对联动字段短暂 disabled 提供优雅重试直至解锁成功', async () => {
  let tries = 0;
  const out = await runAction({
    name: 'fill dependent-city',
    timeoutMs: 200,
    disabledGraceMs: 800,
    attempt: async () => {
      tries += 1;
      if (tries < 3) {
        throw Object.assign(new Error('元素是 disabled（等待上级省市区联动解锁）'), { code: 'NOT_ACTIONABLE' });
      }
      return 'unlocked';
    },
  });
  assert.equal(out, 'unlocked');
  assert.equal(tries, 3);
});

test('所有新增错误码的 Remedy 模板均可被 CLI 校验器合法解析', () => {
  for (const code of [
    'TAB_GONE',
    'FLOW_AUTH_EXPIRED',
    'FLOW_RATE_LIMITED',
    'FLOW_UNKNOWN_FIELD',
    'GRID_EDIT_REJECTED',
    'SECRET_REJECTED',
    'STATE_TOO_LARGE',
  ]) {
    const details = resolveErrorDetails({ code }, { envId: 'demo' });
    assert.ok(details?.hint && details?.remedy, `${code} 缺少 hint 或 remedy`);
  }
  const remedies = sampleBuiltInRemedies();
  assert.ok(remedies.length >= 20);
  for (const cmd of remedies) {
    const argv = cmd.trim().split(/\s+/).slice(1);
    const check = validateCliInvocation(argv);
    assert.equal(check.ok, true, `非法 remedy 命令：${cmd} (${check.reason ?? ''})`);
  }
});
