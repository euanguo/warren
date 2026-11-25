import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeUserAgent } from '../src/main/domain/user-agent.ts';

// 实测原串：Electron 44.7.0 + productName=Warren（见 docs/CHROME-SHELL-PLAN.md §2.7）
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Warren/0.1.0 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36';

test('去掉应用名与 Electron 段，版本冻结成 <major>.0.0.0', () => {
  assert.equal(
    chromeUserAgent(ELECTRON_UA),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  );
});

test('平台段跟着走，不写死 macOS', () => {
  assert.equal(
    chromeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Warren/0.1.0 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36',
    ),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  );
});

test('形状不认识时原样返回，不吐坏 UA', () => {
  assert.equal(chromeUserAgent(''), '');
  assert.equal(chromeUserAgent('Mozilla/5.0 (Macintosh) Foo/1.0'), 'Mozilla/5.0 (Macintosh) Foo/1.0');
});
