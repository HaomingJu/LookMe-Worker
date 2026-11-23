import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { encode } from 'jpeg-js';
import worker from '../src/index';
import { drainOutbox, dispatchSettings, type DispatchEnv } from '../src/outbox';
import { DEFAULT_ANALYSIS_VERSION } from '../../shared/analysis-config';

const settings = { PHOTO_ANALYSIS_ENABLED: true, OUTBOX_BATCH_SIZE: 10, OUTBOX_LEASE_SECONDS: 60,
  OUTBOX_RETRY_BASE_SECONDS: 60, OUTBOX_RETRY_MAX_SECONDS: 3600 };
const token = 'lm_' + 'e'.repeat(64);
const image = new Uint8Array(encode({ width: 2, height: 2, data: new Uint8Array(16).fill(120) }, 80).data);
let mf: Miniflare, db: D1Database, bucket: R2Bucket, env: DispatchEnv & { PHOTOS: R2Bucket };
let sendBatch: ReturnType<typeof vi.fn>;
const row = (id: string) => db.prepare('SELECT * FROM photo_analysis_dispatch WHERE photo_id = ?').bind(id).first<any>();
const count = async (table: 'photos' | 'photo_analysis_dispatch') => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const pending = () => db.prepare('SELECT * FROM photo_analysis_dispatch WHERE published_at_ms IS NULL ORDER BY photo_id').all<any>();
async function upload(id = crypto.randomUUID(), target = env) {
  const data = new FormData();
  data.set('client_photo_id', id); data.set('source', 'cli'); data.set('file', new Blob([image], { type: 'image/jpeg' }), 'synthetic.jpg');
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { tasks.push(p); } } as ExecutionContext;
  const response = await worker.fetch(new Request('http://localhost/photos', { method: 'POST', body: data, headers: { Authorization: `Bearer ${token}` } }), target, ctx);
  await Promise.all(tasks);
  return { response, body: await response.json() as any };
}
async function seed(now: number, dispatch = true) {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO photos(photo_id,owner_id,client_photo_id,object_key,sha256,byte_size,width,height,source,uploaded_at_ms)
    VALUES (?, 'outbox-owner', ?, ?, ?, ?, 2, 2, 'cli', ?)`)
    .bind(id, crypto.randomUUID(), `test/${id}`, 'a'.repeat(64), image.length, now).run();
  if (dispatch) await db.prepare(`INSERT INTO photo_analysis_dispatch
    (photo_id,analysis_version,dispatch_after_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)`)
    .bind(id, DEFAULT_ANALYSIS_VERSION, now, now, now).run();
  return id;
}
function failPublishMark(afterCommit: boolean): D1Database {
  let failed = false;
  return new Proxy(db, { get(target, key) {
    if (key !== 'prepare') { const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value; }
    return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): any => new Proxy(statement, { get(s, member) {
        if (member === 'bind') return (...args: unknown[]) => wrap(s.bind(...args));
        if (member === 'run' && sql.includes('SET published_at_ms =')) return async () => {
          if (failed) return s.run(); failed = true;
          if (afterCommit) await s.run();
          throw new Error('数据库响应失败，不应出现在日志中');
        };
        const value = (s as any)[member]; return typeof value === 'function' ? value.bind(s) : value;
      } });
      return wrap(target.prepare(sql));
    };
  } });
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', compatibilityDate: '2026-11-19', d1Databases: ['DB'], r2Buckets: ['PHOTOS'], outboundService: () => { throw new Error('禁止公网'); } }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  bucket = await mf.getR2Bucket('PHOTOS') as unknown as R2Bucket;
  for (const name of (await readdir('migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const sql = (await readFile(`migrations/${name}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(x => x.trim())) await db.prepare(statement).run();
  }
  const now = Date.now();
  await db.prepare("INSERT INTO users(user_id,created_at_ms) VALUES('outbox-owner',?)").bind(now).run();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  await db.prepare(`INSERT INTO user_tokens(token_id,user_id,token_hash,created_at_ms,expires_at_ms) VALUES('outbox-token','outbox-owner',?,?,?)`).bind(hash, now, now + 86400000).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.prepare('DELETE FROM photo_analysis_dispatch').run();
  await db.prepare('DELETE FROM photos').run();
  sendBatch = vi.fn(async () => {});
  env = { ...settings, DB: db, PHOTOS: bucket, IMAGE2TXT_QUEUE: { sendBatch } as any };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('上传事务与自动投递', () => {
  it('照片和Outbox同时提交，发送仅包含ID和固定版本，成功后标记published', async () => {
    const result = await upload();
    expect(result.response.status).toBe(201);
    expect(await count('photos')).toBe(1);
    expect(await count('photo_analysis_dispatch')).toBe(1);
    expect(sendBatch).toHaveBeenCalledWith([{ body: { photo_id: result.body.photo_id, analysis_version: DEFAULT_ANALYSIS_VERSION }, contentType: 'json' }]);
    expect(await row(result.body.photo_id)).toMatchObject({ publish_attempts: 1, lease_token: null, error_code: null });
    expect((await row(result.body.photo_id)).published_at_ms).not.toBeNull();
  });
  it('Outbox插入失败使照片插入回滚，不能出现只有照片没有任务的成功上传', async () => {
    await db.prepare("CREATE TRIGGER test_reject_dispatch BEFORE INSERT ON photo_analysis_dispatch BEGIN SELECT RAISE(ABORT, 'test'); END").run();
    try {
      expect((await upload()).response.status).toBe(503);
      expect(await count('photos')).toBe(0);
      expect(await count('photo_analysis_dispatch')).toBe(0);
      expect(sendBatch).not.toHaveBeenCalled();
    } finally { await db.prepare('DROP TRIGGER test_reject_dispatch').run(); }
  });
  it('Queue失败不改变上传成功响应，保留持久记录等待补投', async () => {
    sendBatch.mockRejectedValueOnce(new Error('private queue error'));
    const result = await upload();
    expect(result.response.status).toBe(201);
    const failed = await row(result.body.photo_id);
    expect(failed).toMatchObject({ published_at_ms: null, publish_attempts: 1, error_code: 'queue_publish_unconfirmed' });
    await drainOutbox(env, undefined, () => failed.dispatch_after_ms);
    expect((await row(result.body.photo_id)).published_at_ms).not.toBeNull();
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0][0]).toEqual(sendBatch.mock.calls[1][0]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private queue error');
  });
  it('重复与并发上传只生成一条Outbox，不重发已标记成功的任务', async () => {
    const clientId = crypto.randomUUID();
    const results = await Promise.all([upload(clientId), upload(clientId)]);
    expect(results.map(x => x.response.status).sort()).toEqual([200, 201]);
    expect(results[0].body.photo_id).toBe(results[1].body.photo_id);
    expect(await count('photo_analysis_dispatch')).toBe(1);
    expect(sendBatch).toHaveBeenCalledOnce();
    expect((await upload(clientId)).response.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledOnce();
  });
  it('D1事务已提交但响应丢失，通过现有记录恢复且任务不丢失', async () => {
    let fail = true;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        if (fail) { fail = false; throw new Error('响应丢失'); }
        return result;
      };
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await upload(undefined, { ...env, DB: wrapped })).response.status).toBe(200);
    expect(await count('photos')).toBe(1);
    expect(await count('photo_analysis_dispatch')).toBe(1);
    expect(sendBatch).toHaveBeenCalledOnce();
  });
  it('迁移前旧照片重传不创建Outbox，关闭开关期间上传也不自动补跑', async () => {
    const clientId = crypto.randomUUID();
    const first = await upload(clientId, { ...env, PHOTO_ANALYSIS_ENABLED: false });
    expect(first.response.status).toBe(201);
    expect((await upload(clientId)).response.status).toBe(200);
    await drainOutbox(env);
    expect(await count('photo_analysis_dispatch')).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe('定时补投、租约和不确定响应', () => {
  it('scheduled只补投已有Outbox，不扫描照片生成历史任务', async () => {
    const now = Date.now() - 1000;
    const old = await seed(now, false), queued = await seed(now);
    await worker.scheduled({} as ScheduledController, env);
    expect(await row(old)).toBeNull();
    expect((await row(queued)).published_at_ms).not.toBeNull();
    expect(sendBatch).toHaveBeenCalledOnce();
  });
  it('一轮受batch_size限制，不在单次调用中无限清空积压', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await seed(now);
    await drainOutbox({ ...env, OUTBOX_BATCH_SIZE: 2 }, undefined, () => now);
    expect(sendBatch.mock.calls[0][0]).toHaveLength(2);
    expect((await pending()).results).toHaveLength(1);
    await drainOutbox({ ...env, OUTBOX_BATCH_SIZE: 2 }, undefined, () => now);
    expect(sendBatch.mock.calls[1][0]).toHaveLength(1);
  });
  it('并发Cron/即时投递只能领取一次，崩溃遗留的过期lease可恢复', async () => {
    const now = Date.now(), id = await seed(now);
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    sendBatch.mockImplementationOnce(async () => { started(); await new Promise<void>(r => { release = r; }); });
    const first = drainOutbox(env, id, () => now);
    await entered;
    await drainOutbox(env, id, () => now);
    expect(sendBatch).toHaveBeenCalledOnce();
    release(); await first;
    const retry = await seed(now);
    await db.prepare('UPDATE photo_analysis_dispatch SET lease_token=?,lease_until_ms=?,publish_attempts=1 WHERE photo_id=?').bind('crashed', now - 1, retry).run();
    await drainOutbox(env, retry, () => now);
    expect(await row(retry)).toMatchObject({ publish_attempts: 2, lease_token: null });
  });
  it.each([false, true])('Queue已接收而D1标记响应失败（已提交=%s），允许安全重复但不回退成功行', async afterCommit => {
    const now = Date.now(), id = await seed(now);
    await drainOutbox({ ...env, DB: failPublishMark(afterCommit) }, id, () => now);
    const current = await row(id);
    expect(current.published_at_ms !== null).toBe(afterCommit);
    await drainOutbox(env, id, () => now + 60001);
    expect(sendBatch).toHaveBeenCalledTimes(afterCommit ? 1 : 2);
    expect((await row(id)).published_at_ms).not.toBeNull();
  });
  it('退避时间持久化且有上限；未到时间的重投不会增加尝试次数', async () => {
    const now = Date.now(), id = await seed(now);
    sendBatch.mockRejectedValue(new Error('不可达'));
    await db.prepare('UPDATE photo_analysis_dispatch SET publish_attempts=50 WHERE photo_id=?').bind(id).run();
    await drainOutbox(env, id, () => now);
    expect((await row(id)).dispatch_after_ms).toBe(now + 3600_000);
    await drainOutbox(env, id, () => now + 1000);
    expect((await row(id)).publish_attempts).toBe(51);
    expect(sendBatch).toHaveBeenCalledOnce();
  });
  it('旧lease的发送完成不能覆盖新lease', async () => {
    const now = Date.now(), id = await seed(now);
    sendBatch.mockImplementationOnce(async () => {
      await db.prepare('UPDATE photo_analysis_dispatch SET lease_token=?,lease_until_ms=? WHERE photo_id=?').bind('new-owner', now + 120000, id).run();
    });
    await drainOutbox(env, id, () => now);
    expect(await row(id)).toMatchObject({ lease_token: 'new-owner', published_at_ms: null });
  });
  it('暂停时不领取已有任务；缺Queue时留存失败任务等待修复', async () => {
    const now = Date.now(), id = await seed(now);
    await drainOutbox({ ...env, PHOTO_ANALYSIS_ENABLED: false }, id, () => now);
    expect((await row(id)).publish_attempts).toBe(0);
    await drainOutbox({ ...env, IMAGE2TXT_QUEUE: undefined as any }, id, () => now);
    expect(await row(id)).toMatchObject({ publish_attempts: 1, published_at_ms: null, error_code: 'queue_publish_unconfirmed' });
  });
  it.each([{ OUTBOX_BATCH_SIZE: 0 }, { OUTBOX_BATCH_SIZE: 101 }, { OUTBOX_LEASE_SECONDS: 0 },
    { OUTBOX_RETRY_BASE_SECONDS: 3601 }, { OUTBOX_RETRY_MAX_SECONDS: 10 }, { PHOTO_ANALYSIS_ENABLED: 'true' }])('拒绝无效Wrangler参数 %j', invalid => {
    expect(() => dispatchSettings({ ...env, ...invalid } as any)).toThrow('invalid_outbox_configuration');
  });
});
