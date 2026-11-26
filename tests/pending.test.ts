import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebContents } from 'electron';
import { EnvPending } from '../src/main/browser/pending.ts';

/** 这个队列只把 wc 透传给 session 的 dialog 查询，测试里不需要真 webContents。 */
function fakeWc(): WebContents {
  return {} as WebContents;
}

function popup(url: string, at: string) {
  return { tabId: 'tab-1', index: 2, url, at };
}

function download(id: string, at: string) {
  return { downloadId: id, url: `http://x/${id}`, filename: `${id}.txt`, at };
}

function fakeHandle(path: string) {
  return {
    item: { getState: () => 'completed' } as never,
    url: 'http://x',
    filename: 'a.txt',
    path,
  };
}

test('popup 队列先进先出，读走就没了', () => {
  const pending = new EnvPending();
  const sink = pending.sinkFor(fakeWc());
  pending.notePopup(popup('http://a', '2026-01-01T00:00:01.000Z'));
  pending.notePopup(popup('http://b', '2026-01-01T00:00:02.000Z'));

  assert.equal(sink.consumePopup()?.url, 'http://a');
  assert.equal(sink.consumePopup()?.url, 'http://b');
  assert.equal(sink.consumePopup(), null, '读空之后返回 null');
});

test('收据只报动作开始之后产生的 popup', () => {
  const pending = new EnvPending();
  const sink = pending.sinkFor(fakeWc());
  const before = Date.parse('2026-01-01T00:00:00.000Z');
  pending.notePopup(popup('http://old', '2025-12-31T23:59:59.999Z'));
  pending.notePopup(popup('http://new', '2026-01-01T00:00:00.500Z'));

  assert.deepEqual(
    sink.receiptSince(before).popups?.map((p) => p.url),
    ['http://new'],
  );
  // 同一毫秒也算「本次动作产生的」：边界用 >=，否则会漏报刚开出来的标签
  assert.deepEqual(
    sink.receiptSince(Date.parse('2026-01-01T00:00:00.500Z')).popups?.map((p) => p.url),
    ['http://new'],
  );
});

test('没有 popup 时收据不带 popups 字段', () => {
  const pending = new EnvPending();
  const sink = pending.sinkFor(fakeWc());
  assert.equal(sink.receiptSince(0).popups, undefined);
});

test('下载能按 id 取回句柄，clear 之后取不到', () => {
  const pending = new EnvPending();
  pending.noteDownload(download('d1', '2026-01-01T00:00:01.000Z'), fakeHandle('/tmp/d1.txt'));
  assert.equal(pending.downloadById('d1')?.path, '/tmp/d1.txt');
  assert.equal(pending.downloadById('nope'), null);

  pending.clear();
  assert.equal(pending.downloadById('d1'), null, '环境停止后临时下载句柄必须一起丢掉');
});

test('下载记录只保留最近 N 条，句柄跟着一起裁', () => {
  const pending = new EnvPending({ maxDownloads: 3 });
  const sink = pending.sinkFor(fakeWc());
  for (let i = 1; i <= 5; i++) {
    pending.noteDownload(download(`d${i}`, `2026-01-01T00:00:0${i}.000Z`), fakeHandle(`/tmp/d${i}.txt`));
  }
  const ids: string[] = [];
  let item = sink.consumeDownload();
  while (item) {
    ids.push(item.downloadId);
    item = sink.consumeDownload();
  }
  assert.deepEqual(ids, ['d3', 'd4', 'd5'], '只留最近 3 条，长驻环境不会一直涨');
  assert.equal(pending.downloadById('d1'), null, '被裁掉的句柄也要释放');
  assert.equal(pending.downloadById('d5')?.path, '/tmp/d5.txt');
});
