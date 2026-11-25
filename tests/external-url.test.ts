import assert from 'node:assert/strict';
import test from 'node:test';
import { isOpenableExternalUrl } from '../src/main/external-url.ts';

test('放行 http 和 https', () => {
  assert.equal(isOpenableExternalUrl('https://example.com/a?b=1#c'), true);
  assert.equal(isOpenableExternalUrl('http://127.0.0.1:8899/login'), true);
});

test('拒绝会把系统拖进别的协议处理器的地址', () => {
  // 页面可以把自己导航到这些地址，再等人点「在外部浏览器打开」
  assert.equal(isOpenableExternalUrl('file:///etc/passwd'), false);
  assert.equal(isOpenableExternalUrl('javascript:alert(1)'), false);
  assert.equal(isOpenableExternalUrl('smb://host/share'), false);
  assert.equal(isOpenableExternalUrl('vscode://x'), false);
  assert.equal(isOpenableExternalUrl('data:text/html,<script>1</script>'), false);
});

test('拒绝不是地址的输入', () => {
  assert.equal(isOpenableExternalUrl(''), false);
  assert.equal(isOpenableExternalUrl('example.com'), false);
  assert.equal(isOpenableExternalUrl('/relative/path'), false);
});
