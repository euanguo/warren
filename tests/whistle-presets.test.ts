import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStaticOnlyLayer,
  composePreset,
  diffRules,
  importRulesText,
  localStaticOnlyLayer,
  mergePresets,
  resolvePresetVariables,
  SCENARIOS,
  scenarioLayers,
  scenarioPresetIds,
  sha256,
  staticAssetMatcher,
  staticAssetPattern,
  validatePreset,
  validateRulesText,
} from '../plugins/whistle/presets.mjs';

function fixturePreset() {
  return {
    schemaVersion: 1,
    id: 'fixture',
    name: '测试夹具',
    category: 'test',
    builtin: false,
    variables: {
      backendIp: { type: 'ip', label: '测试后端', required: true },
      consolePort: { type: 'port', label: '控制台端口', required: true },
    },
    layers: [
      {
        id: 'backend',
        kind: 'backendMap',
        enabled: true,
        target: '{{backendIp}}',
        hosts: ['console.example.com', 'buy.example.com'],
      },
      {
        id: 'local-console',
        kind: 'localAssets',
        enabled: true,
        rules: ['/\\/app\\.js/ http://127.0.0.1:{{consolePort}}/app.js'],
      },
    ],
  };
}

test('预设夹具能通过校验并稳定合成', () => {
  const definition = fixturePreset();
  const validation = validatePreset(definition);
  assert.equal(validation.ok, true, validation.errors.map((item) => item.message).join('; '));
  const variables = { backendIp: '192.0.2.10', consolePort: 19000 };
  const first = composePreset(definition, { variables });
  const second = composePreset(definition, { variables });
  assert.deepEqual(first.errors, []);
  assert.equal(first.hash, second.hash);
  assert.match(first.rules, /192\.0\.2\.10 console\.example\.com/);
});

test('端口必须由运行时传入，变量覆盖生效', () => {
  const definition = fixturePreset();
  const missing = composePreset(definition, { variables: { backendIp: '192.0.2.10' } });
  assert.ok(missing.errors.some((item) => /不能为空|未解析变量/.test(item.message)));
  const result = composePreset(definition, {
    variables: { backendIp: '192.0.2.10', consolePort: 9444 },
  });
  assert.equal(result.errors.length, 0);
  assert.match(result.rules, /127\.0\.0\.1:9444\/app\.js/);
  assert.doesNotMatch(result.rules, /\{\{consolePort\}\}/);
});

test('本地端口可由当前本地地址注入；线上地址不会被当作 dev server', () => {
  const definition = fixturePreset();
  assert.deepEqual(
    resolvePresetVariables([definition], {
      variables: { backendIp: '192.0.2.10', consolePort: 9444 },
    }),
    { backendIp: '192.0.2.10', consolePort: 9444 },
  );
  assert.deepEqual(resolvePresetVariables([definition], { localUrl: 'https://console.example.com/chat' }), {});
});

test('缺失/非法变量阻止合成', () => {
  const definition = fixturePreset();
  const result = composePreset({
    ...definition,
    variables: {
      ...definition.variables,
      backendIp: { type: 'ip', label: 'backend', required: true },
    },
  });
  assert.ok(result.errors.some((item) => /不能为空/.test(item.message)));

  const invalid = composePreset(definition, {
    variables: { backendIp: 'not-an-ip', consolePort: 19000 },
  });
  assert.ok(invalid.errors.some((item) => /必须是 IPv4/.test(item.message)));
});

test('变量换行会被拒绝，防止规则注入', () => {
  const definition = fixturePreset();
  const result = composePreset(definition, {
    variables: { backendIp: '192.0.2.10\n198.51.100.10 evil.example', consolePort: 19000 },
  });
  assert.equal(
    result.errors.some((item) => /必须是 IPv4/.test(item.message)),
    true,
  );
});

test('层关闭后不出现在合成结果里，未知层被拒绝', () => {
  const definition = fixturePreset();
  const result = composePreset(definition, {
    variables: { backendIp: '192.0.2.10', consolePort: 19000 },
    layers: { backend: false },
  });
  assert.equal(result.errors.length, 0);
  assert.doesNotMatch(result.rules, /console\.example\.com/);

  const bad = composePreset({
    ...definition,
    layers: [{ id: 'x', kind: 'not-real', enabled: true, rules: ['a b'] }],
  });
  assert.ok(bad.errors.some((item) => /未知 layer kind/.test(item.message)));
});

test('导入现有规则会分类为 draft，且不直接应用', () => {
  const text = [
    '# backend',
    '192.0.2.10 console.example.com',
    '/\\/static\\/app\\.js/ http://127.0.0.1:19000/app.js',
    '/cgi/capi\\?.*cmd=DescribeFoo/ file:///tmp/Foo.json',
    'unknown line here and there',
  ].join('\n');
  const result = importRulesText(text, { id: 'my-preset', name: '我的预设' });
  assert.equal(result.draft.draft, true);
  assert.ok(result.draft.layers.length >= 2);
  assert.ok(result.warnings.some((item) => /无法分类/.test(item.message)));
  assert.ok(result.draft.layers.some((layer) => layer.kind === 'backendMap'));
  assert.ok(result.draft.layers.some((layer) => layer.kind === 'raw'));
});

test('规则文本校验：未解析变量 / 宽泛 ignore / 空文本', () => {
  assert.equal(validateRulesText('192.0.2.10 console.example.com').ok, true);
  assert.equal(validateRulesText('{{backendIp}} console.example.com').ok, false);
  assert.ok(validateRulesText('* ignore://*').warnings.some((item) => /ignore/.test(item.message)));
  assert.deepEqual(validateRulesText('').lineCount, 0);
});

test('diffRules 稳定给出新增/删除与 hash', () => {
  const result = diffRules('a b\nc d\n', 'a b\ne f\n');
  assert.equal(result.same, false);
  assert.deepEqual(result.removed, ['c d']);
  assert.deepEqual(result.added, ['e f']);
  assert.notEqual(result.beforeHash, result.afterHash);
  assert.equal(sha256('x'), sha256('x'));
});

test('mergePresets 合并变量与层，同 id 层以后者为准', () => {
  const a = fixturePreset();
  const b = {
    ...fixturePreset(),
    id: 'fixture-local',
    name: '本地层',
    layers: [
      {
        id: 'local-console',
        kind: 'localAssets',
        enabled: true,
        rules: ['/\\/local\\.js/ http://127.0.0.1:{{consolePort}}/local.js'],
      },
    ],
  };
  const merged = mergePresets([a, b]);
  assert.equal(merged.layers.length, 2);
  assert.deepEqual(
    merged.layers.map((layer: { id: string }) => layer.id),
    ['backend', 'local-console'],
  );
  const composed = composePreset(merged, {
    variables: { backendIp: '192.0.2.10', consolePort: 19000 },
  });
  assert.equal(composed.errors.length, 0);
  assert.match(composed.rules, /127\.0\.0\.1:19000\/local\.js/);
});

test('四种验证场景只选择层，不硬编码用户预设 ID', () => {
  assert.deepEqual(scenarioLayers('online'), {
    'cdn-preview': true,
    'corporate-proxy': false,
    backend: false,
    'local-console': false,
    'local-trtc-intl': false,
    'local-buy': false,
  });
  assert.equal(scenarioLayers('test').backend, true);
  assert.deepEqual(scenarioPresetIds('test'), []);
  assert.equal(scenarioLayers('test')['cdn-preview'], true);
  assert.equal(scenarioLayers('test')['local-console'], false);
  assert.equal(scenarioLayers('local')['local-console'], false);
  assert.equal(scenarioLayers('local')['local-trtc-intl'], false);
  assert.equal(scenarioLayers('local')['local-buy'], false);
  assert.deepEqual(scenarioPresetIds('local'), []);
  assert.equal(scenarioLayers('preview')['local-console'], false);
  assert.equal(scenarioLayers('preview')['local-trtc-intl'], false);
  assert.equal(scenarioLayers('preview')['local-buy'], false);
  assert.equal(SCENARIOS.online.name, '线上验证');
  assert.throws(() => scenarioLayers('missing'), /未知场景/);
  assert.throws(() => scenarioPresetIds('missing'), /未知场景/);
});

test('local-static-only：静态资源走本地，document 与 POST 直达测试后端', () => {
  const options = { host: 'console.example.com', localPort: 8323 };
  const matches = staticAssetMatcher(options);
  // 静态资源命中（含 query / hash，审计里的 im-buy.zh.<hash>.js?max_age=... 是真实形态）
  assert.equal(matches('https://console.example.com/app.js'), true);
  assert.equal(matches('https://console.example.com/static/im-buy.zh.3f2a.js?max_age=31536000'), true);
  assert.equal(matches('https://console.example.com/static/index.css'), true);
  assert.equal(matches('https://console.example.com/fonts/Geist.woff2#x'), true);
  // document 与业务请求不命中：它们必须继续走测试后端
  assert.equal(matches('https://console.example.com/'), false);
  assert.equal(matches('https://console.example.com/index.html?from=login'), false);
  assert.equal(matches('https://console.example.com/order/check'), false);
  assert.equal(matches('https://console.example.com/cgi/capi?cmd=DescribeFoo'), false);
  // 别的 host 的静态资源不受影响
  assert.equal(matches('https://login.example.com/app.js'), false);
});

test('local-static-only：规则文本可被预设合成，且本地端口只出现在静态规则里', () => {
  const base = fixturePreset();
  const withLayer = appendStaticOnlyLayer(base, { host: 'console.example.com', localPort: 19000 });
  assert.equal(validatePreset(withLayer).ok, true);
  const composed = composePreset(withLayer, {
    variables: { backendIp: '192.0.2.10', consolePort: 9444 },
  });
  assert.deepEqual(composed.errors, []);
  assert.match(composed.rules, /layer: local-static-only \(localStaticOnly\)/);
  assert.match(composed.rules, /\\\.\(\?:js\|mjs\|css/);
  assert.match(composed.rules, /http:\/\/127\.0\.0\.1:19000/);
  // 同一份定义两次合成 hash 稳定
  assert.equal(
    composed.hash,
    composePreset(withLayer, { variables: { backendIp: '192.0.2.10', consolePort: 9444 } }).hash,
  );
  // 同 id 再追加是替换，不是重复叠加
  const replaced = appendStaticOnlyLayer(withLayer, { host: 'console.example.com', localPort: 19001 });
  assert.equal(replaced.layers.filter((layer: { id: string }) => layer.id === 'local-static-only').length, 1);
});

test('local-static-only：host 省略时不锚定 host，缺 localPort 直接拒绝', () => {
  const everywhere = staticAssetPattern({});
  assert.doesNotMatch(everywhere, /\^https/);
  assert.match(everywhere, /\\\.\(\?:js\|/);
  assert.throws(() => localStaticOnlyLayer({}), /localPort/);
  assert.throws(() => localStaticOnlyLayer({ localPort: 0 }), /localPort/);
  assert.throws(() => localStaticOnlyLayer({ localPort: 70000 }), /localPort/);
});
