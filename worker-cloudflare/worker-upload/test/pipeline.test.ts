import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { encode } from 'jpeg-js';
import { DEFAULT_ANALYSIS_VERSION, DEFAULT_ANALYSIS_PROFILE } from '../../shared/analysis-config';

let mf: Miniflare;
const calls: any[] = [];
const token = 'lm_' + '6'.repeat(64);
const input = encode({ width: 2, height: 2, data: new Uint8Array(16).fill(128) }, 80).data;
async function upload(clientId: string) {
  const form = new FormData(); form.set('client_photo_id', clientId); form.set('source', 'cli');
  form.set('file', new Blob([input], { type: 'image/jpeg' }), 'synthetic.jpg');
  const req = new Request('http://localhost/photos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return mf.dispatchFetch(req.url, { method: 'POST', headers: Object.fromEntries(req.headers), body: await req.arrayBuffer() });
}
beforeAll(async () => {
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text;
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'upload', modules: true, script: await bundle('test/pipeline-upload-fixture.ts'), compatibilityDate: '2026-11-19',
      d1Databases: { DB: 'shared-pipeline-db' }, r2Buckets: { PHOTOS: 'shared-pipeline-photos' },
      bindings: { PHOTO_ANALYSIS_ENABLED: true, OUTBOX_BATCH_SIZE: 10, OUTBOX_LEASE_SECONDS: 60, OUTBOX_RETRY_BASE_SECONDS: 60, OUTBOX_RETRY_MAX_SECONDS: 3600 },
      queueProducers: { IMAGE2TXT_QUEUE: 'pipeline-analysis' },
      outboundService: () => { throw new Error('禁止公网'); },
    },
    { name: 'analysis', modules: true, script: await bundle('../worker-image2txt/test/queue-fixture.ts'), compatibilityDate: '2026-11-19',
      d1Databases: { DB: 'shared-pipeline-db' }, r2Buckets: { PHOTOS: 'shared-pipeline-photos' },
      queueConsumers: { 'pipeline-analysis': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } },
      outboundService: () => { throw new Error('禁止真实模型'); },
      serviceBindings: { MOCK_AI: async request => {
        calls.push(await request.json());
        return Response.json({ id: 'pipeline-mock', choices: [{ index: 0, message: { role: 'assistant', content: '本地管道合成图描述' }, finish_reason: 'stop' }] });
      } },
    },
  ] }));
  const db = await mf.getD1Database('DB', 'upload');
  for (const name of (await readdir('migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const sql = (await readFile(`migrations/${name}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(x => x.trim())) await db.prepare(statement).run();
  }
  const now = Date.now();
  await db.prepare("INSERT INTO users(user_id,created_at_ms) VALUES('pipeline-owner',?)").bind(now).run();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  await db.prepare("INSERT INTO user_tokens(token_id,user_id,token_hash,created_at_ms,expires_at_ms) VALUES('pipeline-token','pipeline-owner',?,?,?)").bind(hash, now, now + 86400000).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });
it('真实本地上传→Outbox投递失败→scheduled补投→Queue→mock AI→文字落库，重传不重新分析', async () => {
  const client = crypto.randomUUID(), first = await upload(client);
  expect(first.status).toBe(201);
  const { photo_id } = await first.json() as any;
  const db = await mf.getD1Database('DB', 'upload');
  await vi.waitFor(async () => {
    expect(await db.prepare('SELECT publish_attempts,error_code,published_at_ms FROM photo_analysis_dispatch WHERE photo_id=?').bind(photo_id).first())
      .toEqual({ publish_attempts: 1, error_code: 'queue_publish_unconfirmed', published_at_ms: null });
  });
  expect(calls).toHaveLength(0);
  // 测试推进持久化重试时刻，不真实等待一分钟。
  await db.prepare('UPDATE photo_analysis_dispatch SET dispatch_after_ms=? WHERE photo_id=?').bind(Date.now() - 1, photo_id).run();
  const runtime = await mf.getWorker('upload');
  await runtime.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  await vi.waitFor(async () => {
    expect(await db.prepare('SELECT status,result_text,analysis_version FROM photo_analyses WHERE photo_id=?').bind(photo_id).first())
      .toEqual({ status: 'succeeded', result_text: '本地管道合成图描述', analysis_version: DEFAULT_ANALYSIS_VERSION });
  }, { timeout: 10000 });
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe(DEFAULT_ANALYSIS_PROFILE.model);
  expect((await upload(client)).status).toBe(200);
  await runtime.scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
  expect(calls).toHaveLength(1);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM photo_analysis_dispatch WHERE photo_id=?').bind(photo_id).first() as any).n).toBe(1);
}, 15000);
