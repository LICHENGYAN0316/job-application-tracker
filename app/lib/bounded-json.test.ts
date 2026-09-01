import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidJsonBodyError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from './bounded-json.ts';

function streamingRequest(chunks: Uint8Array[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request('https://example.com/api/state', {
    method: 'PUT',
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

test('有界流读取可以正常跨 chunk 解析 JSON', async () => {
  const encoder = new TextEncoder();
  const request = streamingRequest([encoder.encode('{"companies"'), encoder.encode(':[]}')]);
  assert.deepEqual(await readBoundedJson(request, 100), { companies: [] });
});

test('即使没有 Content-Length，实际流超限也会立即取消', async () => {
  const request = streamingRequest([new Uint8Array(600), new Uint8Array(600)]);
  await assert.rejects(readBoundedJson(request, 1_000), RequestBodyTooLargeError);
});

test('伪造较小 Content-Length 无法绕过实际流限制', async () => {
  const request = streamingRequest([new Uint8Array(1_001)]);
  request.headers.set('content-length', '10');
  await assert.rejects(readBoundedJson(request, 1_000), RequestBodyTooLargeError);
});

test('非法 JSON 使用独立错误类型', async () => {
  const request = streamingRequest([new TextEncoder().encode('{broken')]);
  await assert.rejects(readBoundedJson(request, 100), InvalidJsonBodyError);
});
