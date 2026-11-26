import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurlCommand,
  buildFaultRuleLine,
  buildMapLocalRuleLine,
  buildQuickMockPlan,
  computeTimings,
  CONTROLLED_GROUPS,
  diffResponses,
  extractMatchedRules,
  matchRulesForUrl,
  MOCK_VALUE_PREFIX,
  upsertManagedRuleLine,
} from '../plugins/whistle/intents.mjs';

test('受控规则组常量与前缀不冲突用户规则组', () => {
  assert.deepEqual(CONTROLLED_GROUPS, {
    mock: 'warren-mock',
    fault: 'warren-fault',
    local: 'warren-local',
  });
  assert.equal(MOCK_VALUE_PREFIX, 'warren-mock-');
});

test('quickMock 构造 JSON Value、状态码、延迟、CORS 与带空格 headers', () => {
  const plan = buildQuickMockPlan({
    pattern: 'https://api.example.com/v1/user',
    body: { ok: true, name: 'alice' },
    statusCode: 201,
    delayMs: 300,
    cors: true,
    headers: { 'X-Mock': '1' },
  });
  assert.equal(plan.group, 'warren-mock');
  assert.ok(plan.valueName.startsWith('warren-mock-'));
  assert.ok(plan.valueName.endsWith('.json'));
  assert.equal(JSON.parse(plan.valueBody).ok, true);
  assert.match(plan.ruleLine, /resBody:\/\/\{warren-mock-/);
  assert.match(plan.ruleLine, /resType:\/\/application\/json/);
  assert.match(plan.ruleLine, /statusCode:\/\/201/);
  assert.match(plan.ruleLine, /resDelay:\/\/300/);
  assert.match(plan.ruleLine, /resCors:\/\/\*/);
  assert.match(plan.ruleLine, /resHeaders:\/\/\(\{"X-Mock":"1"\}\)/);
  assert.equal(plan.extraValues.length, 0);

  // headers 含空格时拆为独立 Value，避免 Whistle 空格分词出错
  const spaced = buildQuickMockPlan({
    pattern: 'api.example.com/v2/items',
    body: 'hello',
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
  assert.equal(spaced.extraValues.length, 1);
  assert.match(spaced.ruleLine, new RegExp(`resHeaders://\\{${spaced.extraValues[0].name}\\}`));
});

test('upsertManagedRuleLine 对同 pattern 幂等替换并保留同组其他规则', () => {
  const initial = [
    '# header comment',
    'https://a.example.com/1 resBody://{m1.json}',
    'https://b.example.com/2 resBody://{m2.json}',
  ].join('\n');
  const updated = upsertManagedRuleLine(
    initial,
    'https://a.example.com/1',
    'https://a.example.com/1 resBody://{m1.json} statusCode://404',
  );
  assert.equal(
    updated,
    [
      '# header comment',
      'https://a.example.com/1 resBody://{m1.json} statusCode://404',
      'https://b.example.com/2 resBody://{m2.json}',
    ].join('\n') + '\n',
  );

  const appended = upsertManagedRuleLine(
    updated,
    'https://c.example.com/3',
    'https://c.example.com/3 resBody://{m3.json}',
  );
  assert.match(appended, /https:\/\/c\.example\.com\/3 resBody:\/\/\{m3\.json\}/);
  assert.match(appended, /https:\/\/b\.example\.com\/2/);

  const replacedAll = upsertManagedRuleLine(
    updated,
    'https://d.example.com/4',
    'https://d.example.com/4 statusCode://500',
    {
      append: false,
    },
  );
  assert.equal(replacedAll, 'https://d.example.com/4 statusCode://500\n');
});

test('injectFault 生成延迟、限速、状态码与 Whistle 2.10.15 disable://encoding', () => {
  const fault = buildFaultRuleLine({
    pattern: 'example.com/api/',
    delayMs: 1200,
    reqDelayMs: 200,
    speedKbps: 64,
    statusCode: 503,
    disableCache: true,
    disableEncoding: true,
  });
  assert.equal(fault.group, 'warren-fault');
  assert.equal(
    fault.ruleLine,
    'example.com/api/ resDelay://1200 reqDelay://200 resSpeed://64 statusCode://503 disable://cache disable://encoding',
  );

  assert.throws(
    () => buildFaultRuleLine({ pattern: 'example.com' }),
    (err: Error & { code?: string }) => err.code === 'BAD_REQUEST',
  );
});

test('mapLocal 支持端口映射、targetUrl 与 file/xfile 目录映射', () => {
  const portMap = buildMapLocalRuleLine({ pattern: 'app.example.com/static/', targetPort: 5173 });
  assert.equal(portMap.group, 'warren-local');
  assert.equal(portMap.ruleLine, 'app.example.com/static/ 127.0.0.1:5173');

  const dirMap = buildMapLocalRuleLine({
    pattern: 'cdn.example.com/dist/',
    localDir: '/tmp/dist',
    protocol: 'xfile',
  });
  assert.equal(dirMap.ruleLine, 'cdn.example.com/dist/ xfile:///tmp/dist');

  const urlMap = buildMapLocalRuleLine({
    pattern: 'api.example.com/v1',
    targetUrl: 'http://127.0.0.1:3000/mock',
  });
  assert.equal(urlMap.ruleLine, 'api.example.com/v1 http://127.0.0.1:3000/mock');
});

test('matchRulesForUrl 正确诊断域名、路径、通配符、正则、IP-first 与过滤器', () => {
  const groups = [
    {
      name: 'warren',
      selected: true,
      data: [
        '# 注释行忽略',
        '127.0.0.1:5173 app.example.com/static/',
        'https://api.example.com/v1/ resDelay://500 includeFilter://m:POST',
        '/^https:\\/\\/api\\.example\\.com\\/v1\\/user/i resBody://{user.json} includeFilter://h:x-env=staging',
        '*.example.com/v1/* statusCode://200 excludeFilter://m:DELETE',
      ].join('\n'),
    },
    {
      name: 'disabled-group',
      selected: false,
      data: 'api.example.com/v1/user statusCode://500',
    },
  ];

  const postMatch = matchRulesForUrl(groups, {
    url: 'https://api.example.com/v1/user?id=1',
    method: 'POST',
    headers: { 'X-Env': 'staging' },
  });
  assert.equal(postMatch.matchedCount, 3);
  assert.deepEqual(postMatch.effectiveRules.protocols, {
    resDelay: '500',
    resBody: '{user.json}',
    statusCode: '200',
  });

  const deleteMatch = matchRulesForUrl(groups, {
    url: 'https://api.example.com/v1/user',
    method: 'DELETE',
  });
  assert.equal(deleteMatch.matchedCount, 0);

  const staticMatch = matchRulesForUrl(groups, {
    url: 'https://app.example.com/static/main.js',
    method: 'GET',
  });
  assert.equal(staticMatch.matchedCount, 1);
  assert.deepEqual(staticMatch.effectiveRules.hosts, ['127.0.0.1:5173']);

  const withDisabled = matchRulesForUrl(groups, {
    url: 'https://api.example.com/v1/user',
    method: 'DELETE',
    includeDisabled: true,
  });
  assert.equal(withDisabled.matchedCount, 1);
  assert.equal(withDisabled.matched[0].group, 'disabled-group');
});

test('diffResponses 对比状态码、脱敏响应头与嵌套 JSON 增删改', () => {
  const diff = diffResponses(
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=old', 'X-Old': '1' },
      body: JSON.stringify({ user: { name: 'a', token: 'secret-1' }, removedKey: true }),
    },
    {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'sid=new', 'x-new': '2' },
      body: JSON.stringify({ user: { name: 'b', token: 'secret-2' }, addedKey: 42 }),
    },
  );
  assert.equal(diff.changed, true);
  assert.equal(diff.statusChanged, true);
  assert.deepEqual(diff.statusDiff, { from: 200, to: 201 });
  assert.deepEqual(diff.headersDiff.added, { 'x-new': '2' });
  assert.deepEqual(diff.headersDiff.removed, { 'x-old': '1' });
  // 默认脱敏敏感头（两边的 Set-Cookie 都脱敏为 [REDACTED]，因此不泄露原值）
  assert.equal(diff.headersDiff.changed['set-cookie'], undefined);
  assert.deepEqual(diff.jsonDiff?.added, [{ path: 'addedKey', value: 42 }]);
  assert.deepEqual(diff.jsonDiff?.removed, [{ path: 'removedKey', value: true }]);
  assert.deepEqual(diff.jsonDiff?.changed, [{ path: 'user.name', from: 'a', to: 'b' }]);
});

test('buildCurlCommand 生成可复制 curl 且默认脱敏敏感头与正确单引号转义', () => {
  const session = {
    url: "https://api.example.com/v1/items?q=a'b",
    req: {
      method: 'POST',
      headers: {
        ':method': 'POST',
        'content-length': '18',
        authorization: 'Bearer top-secret',
        cookie: 'sid=abc',
        'content-type': 'application/json',
        'accept-encoding': 'gzip, deflate',
      },
      body: '{"note":"it\'s ok"}',
    },
  };
  const redacted = buildCurlCommand(session);
  assert.ok(!redacted.includes('top-secret'));
  assert.ok(!redacted.includes('sid=abc'));
  assert.ok(!redacted.includes(':method'));
  assert.ok(!redacted.includes('content-length'));
  assert.match(redacted, /authorization: \[REDACTED\]/);
  assert.match(redacted, /cookie: \[REDACTED\]/);
  assert.match(redacted, /--data-raw/);
  assert.match(redacted, /--compressed/);
  assert.ok(redacted.includes("'\\''"));

  const unredacted = buildCurlCommand(session, { includeSensitive: true });
  assert.ok(unredacted.includes('Bearer top-secret'));
  assert.ok(unredacted.includes('sid=abc'));
});

test('computeTimings 与 extractMatchedRules 正确解析 Whistle session 元数据', () => {
  assert.deepEqual(
    computeTimings({
      startTime: 1000,
      dnsTime: 1015,
      connectTime: 1045,
      requestTime: 1060,
      responseTime: 1200,
      endTime: 1260,
    }),
    { dns: 15, connect: 30, ttfb: 200, download: 60, total: 260 },
  );
  assert.deepEqual(computeTimings({ startTime: 1000 }), {
    dns: null,
    connect: null,
    ttfb: null,
    download: null,
    total: null,
  });

  const rules = extractMatchedRules({
    rule: { list: [{ raw: 'api.example.com 127.0.0.1:3000', matcher: '127.0.0.1:3000' }] },
    resDelay: { raw: 'api.example.com resDelay://200', matcher: 'resDelay://200' },
  });
  assert.deepEqual(rules, [
    { protocol: 'rule', matcher: '127.0.0.1:3000', raw: 'api.example.com 127.0.0.1:3000' },
    { protocol: 'resDelay', matcher: 'resDelay://200', raw: 'api.example.com resDelay://200' },
  ]);
});
