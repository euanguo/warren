import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchHostCall } from '../src/main/plugins/api/index.ts';
import { currentEnvironmentId, runWithPluginContext } from '../src/main/plugins/call-context.ts';
import { createTestHandlers } from './helpers/plugin-host.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function handlersFor(seen: string[]) {
  return createTestHandlers({
    pluginId: 'com.example.context',
    currentEnvironmentId,
    require: () => undefined,
    manager: {
      controllerFor: (id: string) => ({
        currentUrl: () => {
          seen.push(id);
          return `url:${id}`;
        },
      }),
    } as never,
  });
}

test('host API 的环境来自调用级上下文，不共享给并发调用', async () => {
  const seen: string[] = [];
  const handlers = handlersFor(seen);

  const [a, b] = await Promise.all([
    runWithPluginContext({ pluginId: 'com.example.context', environmentId: 'a' }, async () => {
      await sleep(20);
      return dispatchHostCall(handlers, 'browser.url', []);
    }),
    runWithPluginContext({ pluginId: 'com.example.context', environmentId: 'b' }, async () => {
      await sleep(5);
      return dispatchHostCall(handlers, 'browser.url', []);
    }),
  ]);

  assert.equal(a, 'url:a');
  assert.equal(b, 'url:b');
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('没有调用级环境时，浏览器能力报 PLUGIN_NO_ENVIRONMENT', async () => {
  const handlers = handlersFor([]);
  await assert.rejects(
    () => dispatchHostCall(handlers, 'browser.url', []),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_NO_ENVIRONMENT',
  );
});
