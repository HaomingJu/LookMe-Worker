import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let mf: Miniflare;
const deadLetters: unknown[] = [];
const providerCalls: { model: string; input: any }[] = [];
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['test/queue-fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: 'consumer', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-19',
        d1Databases: ['DB'], r2Buckets: ['PHOTOS'],
        queueProducers: { INPUT: 'analysis' },
        // 测试缩短为首个失败即转 DLQ；生产配置的重试次数在下面单独检查。
        queueConsumers: { analysis: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0, deadLetterQueue: 'dead' } },
        outboundService: () => { throw new Error('测试禁止真实外部模型调用'); },
        serviceBindings: { MOCK_AI: async request => {
          providerCalls.push(await request.json() as any);
          return Response.json({ id: 'runtime-mock', choices: [{ index: 0,
            message: { role: 'assistant', content: 'workerd 本地合成图描述' }, finish_reason: 'stop' }] });
        } },
      },
      {
        name: 'dead-letter-sink', modules: true, compatibilityDate: '2026-11-19',
        script: `export default { async queue(batch, env) {
          for (const message of batch.messages) {
            await env.CAPTURE.fetch('https://test.invalid', { method: 'POST', body: JSON.stringify(message.body) });
            message.ack();
          }
        } };`,
        queueConsumers: { dead: { maxBatchSize: 1, maxBatchTimeout: 0 } },
        serviceBindings: { CAPTURE: async request => { deadLetters.push(await request.json()); return new Response('ok'); } },
        outboundService: () => { throw new Error('禁止真实外部调用'); },
      },
    ],
  }));
  const db = await mf.getD1Database('DB', 'consumer');
  for (const name of (await readdir('../worker-upload/migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const sql = (await readFile(`../worker-upload/migrations/${name}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(x => x.trim())) await db.prepare(statement).run();
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe('真实本地 Queue 触发器（模型完全 mock）', () => {
  it('打包后的 queue 入口由队列触发并成功写入 D1', async () => {
    const db = await mf.getD1Database('DB', 'consumer');
    const bucket = await mf.getR2Bucket('PHOTOS', 'consumer');
    const producer = await mf.getQueueProducer('INPUT', 'consumer');
    const id = crypto.randomUUID();
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    await db.prepare(`INSERT INTO photos
      (photo_id, owner_id, client_photo_id, object_key, sha256, byte_size, width, height, source, uploaded_at_ms)
      VALUES (?, 'runtime-owner', ?, 'trusted/runtime.jpg', ?, 4, 1, 1, 'cli', 1)`)
      .bind(id, crypto.randomUUID(), hash).run();
    await bucket.put('trusted/runtime.jpg', bytes);
    await producer.send({ photo_id: id, analysis_version: 'v2' });
    await vi.waitFor(async () => {
      expect(await db.prepare('SELECT status, result_text, error_code FROM photo_analyses WHERE photo_id = ?').bind(id).first())
        .toEqual({ status: 'succeeded', result_text: 'workerd 本地合成图描述', error_code: null });
    }, { timeout: 10000 });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(providerCalls[0].input.messages[0].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(deadLetters).toEqual([]);
  }, 15000);
  it('毒消息不隐式 ack，耗尽投递后进入配置的死信队列', async () => {
    const producer = await mf.getQueueProducer('INPUT', 'consumer');
    const bad = { photo_id: 'invalid-uuid', analysis_version: 'v2' };
    await producer.send(bad);
    await vi.waitFor(() => { expect(deadLetters).toEqual([bad]); }, { timeout: 10000 });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(providerCalls[0].input.messages[0].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  }, 15000);
});

const config = async (path: string) => JSON.parse((await readFile(path, 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, ''));
describe('独立且无 HTTP 的配置', () => {
  it('关闭所有环境的 workers.dev、预览和路由，无 HTTP 入口', async () => {
    const remote = await config('wrangler.jsonc');
    const local = await config('wrangler.local.jsonc');
    for (const value of [remote, remote.env.dev, local]) {
      expect(value.workers_dev).toBe(false);
      expect(value.preview_urls).toBe(false);
      expect(value.routes).toEqual([]);
      expect(value.vars).toBeUndefined();
    }
  });
  it('dev 复用上传 Worker 的 D1/R2，迁移只维护一份，并设置有限重试及 DLQ', async () => {
    const remote = await config('wrangler.jsonc');
    const upload = await config('../worker-upload/wrangler.jsonc');
    const local = await config('wrangler.local.jsonc');
    expect(remote.account_id).toBe(upload.account_id);
    const dev = remote.env.dev;
    expect(dev.observability).toEqual({ enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true } });
    expect(dev.limits).toBeUndefined();
    expect(dev.ai).toEqual({ binding: 'AI' });
    expect(local.ai).toEqual({ binding: 'AI' });
    expect(dev.d1_databases[0].database_id).toBe(upload.env.dev.d1_databases[0].database_id);
    expect(dev.r2_buckets[0]).toEqual(upload.env.dev.r2_buckets.find((x: any) => x.binding === 'PHOTOS'));
    expect(resolve(dev.d1_databases[0].migrations_dir)).toBe(resolve('../worker-upload/migrations'));
    expect(dev.queues.consumers).toEqual([{
      queue: 'lookme-dev-image2txt', max_batch_size: 1, max_batch_timeout: 1, max_concurrency: 2,
      max_retries: 8, retry_delay: 60, dead_letter_queue: 'lookme-dev-image2txt-dlq',
    }]);
    expect(local.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(dev.queues.producers).toBeUndefined();
  });
});
