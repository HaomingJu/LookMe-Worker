import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import worker, { createWorker } from '../src/index';
import { CAPTION_PROMPT, caption } from '../src/workers-ai';
import { LEASE_MS, MAX_PREPARATION_ATTEMPTS, MODEL, type Env } from '../src/types';

let mf: Miniflare;
let db: D1Database;
let bucket: R2Bucket;
let now: number;
let env: Env;
const SECRET = 'local-mock-only-do-not-log';
// 合成 1×1 JPEG；不读取本地照片，也不访问真实模型。
const IMAGE = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64'));
const hash = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const bodyFor = (id: string) => ({ photo_id: id, analysis_version: 'v2' });
const completion = (content: unknown, finish_reason = 'stop') => ({ id: 'mock-request-1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }] });
const ok = () => Response.json(completion('一张合成测试图片。'));
let runAI: ReturnType<typeof vi.fn>;
const handler = () => createWorker({ now: () => now });
const row = (id: string) => db.prepare("SELECT * FROM photo_analyses WHERE photo_id = ? AND analysis_version = 'v2'").bind(id).first<any>();

function message(body: unknown) {
  return { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
}
async function deliver(body: unknown, customEnv = env) {
  const m = message(body);
  await handler().queue({ queue: 'test', messages: [m], ackAll: vi.fn(), retryAll: vi.fn() }, customEnv);
  expect(m.ack.mock.calls.length + m.retry.mock.calls.length).toBe(1);
  return m;
}
function retried(m: ReturnType<typeof message>) {
  expect(m.ack).not.toHaveBeenCalled();
  expect(m.retry).toHaveBeenCalledOnce();
}
async function seed(storeObject = true) {
  const id = crypto.randomUUID();
  // 故意不用由 photo_id 推导的路径，验证只信任 D1 中的 object_key。
  const key = `trusted-only/${crypto.randomUUID()}/original.jpg`;
  await db.prepare(`INSERT INTO photos
    (photo_id, owner_id, client_photo_id, object_key, sha256, byte_size, width, height, source, uploaded_at_ms)
    VALUES (?, 'test-owner', ?, ?, ?, ?, 1, 1, 'cli', ?)`)
    .bind(id, crypto.randomUUID(), key, await hash(IMAGE), IMAGE.length, now).run();
  if (storeObject) await bucket.put(key, IMAGE);
  return { id, key };
}
async function forceExpired(id: string, submitted: boolean, attempts = 1) {
  await db.prepare(`INSERT INTO photo_analyses
    (photo_id, analysis_version, model, status, attempt_count, next_attempt_at_ms, lease_token,
     lease_until_ms, provider_attempt_id, provider_submitted_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, 'v2', ?, 'running', ?, ?, 'old-lease', ?, ?, ?, ?, ?)`)
    .bind(id, MODEL, attempts, now - LEASE_MS, now - 1, submitted ? 'old-provider-attempt' : null,
      submitted ? now - LEASE_MS : null, now - LEASE_MS, now - LEASE_MS).run();
}

// 对真实 D1 的某次语句在执行前/提交后制造响应错误，而非用假 SQL 引擎验证状态机。
function failingDb(match: string, afterCommit = false, failAlways = false): D1Database {
  let failed = false;
  return {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): any => ({
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        async first(...args: any[]) {
          const fail = sql.includes(match) && (!failed || failAlways);
          if (fail) failed = true;
          if (fail && !afterCommit) throw new Error(`private error ${SECRET}`);
          const result = await statement.first(...args);
          if (fail) throw new Error(`private error ${SECRET}`);
          return result;
        },
        run: () => statement.run(),
      });
      return wrap(db.prepare(sql));
    },
  } as D1Database;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};',
    compatibilityDate: '2026-11-19', d1Databases: ['DB', 'SNAPSHOT'], r2Buckets: ['PHOTOS'],
    outboundService: () => { throw new Error('测试禁止访问公网'); },
  }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  bucket = await mf.getR2Bucket('PHOTOS') as unknown as R2Bucket;
  for (const name of (await readdir('../worker-upload/migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const sql = (await readFile(`../worker-upload/migrations/${name}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(x => x.trim())) await db.prepare(statement).run();
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(() => {
  now = 1_800_000_000_000;
  runAI = vi.fn(async () => ok());
  env = { DB: db, PHOTOS: bucket, AI: { run: runAI } as unknown as Ai };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Queue 消费与可信数据', () => {
  it('仅导出 queue，不导出 fetch', () => { expect(Object.keys(worker)).toEqual(['queue']); });
  it('读取 D1 指定的私有 R2 图片，保存文字后才 ack，原始元数据不变', async () => {
    const { id, key } = await seed();
    const photo = await db.prepare('SELECT * FROM photos WHERE photo_id = ?').bind(id).first();
    runAI.mockImplementationOnce(async (model, input, options) => {
      expect(model).toBe(MODEL);
      expect(options.returnRawResponse).toBe(true);
      expect(input).toEqual({ messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(IMAGE).toString('base64')}` } },
        { type: 'text', text: CAPTION_PROMPT },
      ] }], max_completion_tokens: 512, stream: false, chat_template_kwargs: { enable_thinking: false } });
      expect((await row(id)).provider_attempt_id).toBeTruthy();
      expect((await row(id)).status).toBe('running');
      return ok();
    });
    const m = message(bodyFor(id));
    let savedAtAck: unknown;
    m.ack.mockImplementation(() => { savedAtAck = row(id); });
    await handler().queue({ queue: 'test', messages: [m], ackAll: vi.fn(), retryAll: vi.fn() }, env);
    expect(await savedAtAck).toMatchObject({ status: 'succeeded', result_text: '一张合成测试图片。' });
    expect(m.retry).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'succeeded', result_text: '一张合成测试图片。', provider_request_id: 'mock-request-1', attempt_count: 1, lease_token: null });
    expect(await db.prepare('SELECT * FROM photos WHERE photo_id = ?').bind(id).first()).toEqual(photo);
    expect(await bucket.get(key)).not.toBeNull();
  });
  it('重复投递（包括大写 UUID）复用结果，不重复读取 R2 或调用模型', async () => {
    const { id } = await seed();
    await deliver(bodyFor(id));
    const get = vi.fn(() => { throw new Error('不应读取'); });
    const m = await deliver(bodyFor(id.toUpperCase()), { ...env, PHOTOS: { get } as any });
    expect(m.ack).toHaveBeenCalledOnce();
    expect(runAI).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
  it.each([null, [], 'raw JSON string', {}, { photo_id: 'bad', analysis_version: 'v2' },
    { photo_id: crypto.randomUUID(), analysis_version: 'v3' },
    { photo_id: crypto.randomUUID(), analysis_version: 'v1' },
    { ...bodyFor(crypto.randomUUID()), object_key: 'attacker/path' },
    { ...bodyFor(crypto.randomUUID()), owner_id: 'attacker' },
    { ...bodyFor(crypto.randomUUID()), MOONDREAM_API_KEY: 'injected' },
  ])('拒绝畸形/未知字段消息，不调用模型并保留给 DLQ：%j', async body => {
    retried(await deliver(body));
    expect(runAI).not.toHaveBeenCalled();
  });
  it('照片不存在时不创建伪造结果，不 ack', async () => {
    const id = crypto.randomUUID();
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toBeNull();
    expect(runAI).not.toHaveBeenCalled();
  });
  it('同批坏消息不会阻止有效消息完成', async () => {
    const { id } = await seed();
    const bad = message(null), good = message(bodyFor(id));
    await handler().queue({ queue: 'test', messages: [bad, good], ackAll: vi.fn(), retryAll: vi.fn() }, env);
    retried(bad);
    expect(good.ack).toHaveBeenCalledOnce();
  });
});

describe('领取、重试与并发隔离', () => {
  it('并发重复投递只允许一个模型请求，其他消息不提前 ack', async () => {
    const { id } = await seed();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entering = new Promise<void>(resolve => { started = resolve; });
    runAI.mockImplementation(async () => { started(); await gate; return ok(); });
    const first = deliver(bodyFor(id));
    await entering;
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => deliver(bodyFor(id))));
    duplicates.forEach(retried);
    expect(runAI).toHaveBeenCalledOnce();
    release();
    expect((await first).ack).toHaveBeenCalledOnce();
    expect((await deliver(bodyFor(id))).ack).toHaveBeenCalledOnce();
  });
  it('发送前过期的 lease 可重新领取', async () => {
    const { id } = await seed();
    await forceExpired(id, false);
    expect((await deliver(bodyFor(id))).ack).toHaveBeenCalledOnce();
    expect((await row(id)).attempt_count).toBe(2);
  });
  it('有调用标记的过期 lease 转待核查，绝不重新调用', async () => {
    const { id } = await seed();
    await forceExpired(id, true);
    retried(await deliver(bodyFor(id)));
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toMatchObject({ status: 'needs_review', provider_attempt_id: 'old-provider-attempt' });
    expect(runAI).not.toHaveBeenCalled();
  });
  it('领取后读取过慢失去 lease，旧消费者不能提交调用', async () => {
    const { id } = await seed();
    const slow = { get: async (key: string) => { now += LEASE_MS + 1; return bucket.get(key); } };
    retried(await deliver(bodyFor(id), { ...env, PHOTOS: slow as any }));
    expect(runAI).not.toHaveBeenCalled();
    expect((await row(id)).provider_attempt_id).toBeNull();
  });
  it('旧消费者失去领取权，不能覆盖新消费者结果', async () => {
    const { id } = await seed();
    let newer: ReturnType<typeof message> | undefined;
    const slow = { get: async (key: string) => {
      now += LEASE_MS + 1;
      newer = await deliver(bodyFor(id));
      return bucket.get(key);
    } };
    retried(await deliver(bodyFor(id), { ...env, PHOTOS: slow as any }));
    expect(newer!.ack).toHaveBeenCalledOnce();
    expect(runAI).toHaveBeenCalledOnce();
    expect((await row(id)).status).toBe('succeeded');
  });
  it('同一调用的迟到结果可从 needs_review 恢复 succeeded', async () => {
    const { id } = await seed();
    runAI.mockImplementationOnce(async () => {
      now += LEASE_MS + 1;
      retried(await deliver(bodyFor(id)));
      expect((await row(id)).status).toBe('needs_review');
      return ok();
    });
    expect((await deliver(bodyFor(id))).ack).toHaveBeenCalledOnce();
    expect((await row(id)).status).toBe('succeeded');
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('R2 暂时丢失时退避，重复消息不能绕过持久化的重试时间', async () => {
    const { id, key } = await seed(false);
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toMatchObject({ status: 'retry_wait', error_code: 'photo_object_missing', attempt_count: 1 });
    retried(await deliver(bodyFor(id)));
    expect((await row(id)).attempt_count).toBe(1);
    await bucket.put(key, IMAGE);
    now += 60_000;
    expect((await deliver(bodyFor(id))).ack).toHaveBeenCalledOnce();
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('准备阶段最多尝试五次，耗尽后仅重试队列直至 DLQ', async () => {
    const { id } = await seed(false);
    for (let i = 0; i < MAX_PREPARATION_ATTEMPTS + 2; i++) {
      retried(await deliver(bodyFor(id)));
      now += 1_000_000;
    }
    expect(await row(id)).toMatchObject({ status: 'failed', attempt_count: 5 });
    expect(runAI).not.toHaveBeenCalled();
  });
  it('反复崩溃导致过期也受领取上限约束', async () => {
    const { id } = await seed();
    await forceExpired(id, false, MAX_PREPARATION_ATTEMPTS);
    retried(await deliver(bodyFor(id)));
    expect((await row(id)).status).toBe('failed');
    expect(runAI).not.toHaveBeenCalled();
  });
  it('缺少 AI binding 不发送模型请求', async () => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, AI: undefined as any }));
    expect((await row(id)).error_code).toBe('missing_ai_binding');
    expect(runAI).not.toHaveBeenCalled();
  });
  it('R2 读取异常可重试，不落入模型调用不确定态', async () => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, PHOTOS: { get: async () => { throw new Error(SECRET); } } as any }));
    expect(await row(id)).toMatchObject({ status: 'retry_wait', provider_attempt_id: null });
    expect(runAI).not.toHaveBeenCalled();
  });
  it.each(['size', 'hash'])('拒绝 R2 %s 不匹配，不上传损坏内容', async mode => {
    const { id, key } = await seed();
    await bucket.put(key, mode === 'size' ? new Uint8Array(IMAGE.length + 1) : new Uint8Array(IMAGE.length));
    retried(await deliver(bodyFor(id)));
    expect((await row(id)).status).toBe('failed');
    expect(runAI).not.toHaveBeenCalled();
  });
});

describe('模型不确定结果与 D1 响应丢失', () => {
  it.each([302, 401, 429, 500, 503])('HTTP %i 不保证未计费，标记待核查且不自动重调', async status => {
    const { id } = await seed();
    runAI.mockResolvedValue(new Response('不要记录供应商正文', { status }));
    retried(await deliver(bodyFor(id)));
    now += LEASE_MS + 1;
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toMatchObject({ status: 'needs_review', error_code: `provider_http_${status}` });
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('网络/超时异常不抹除调用标记，日志不含凭据', async () => {
    const { id } = await seed();
    runAI.mockRejectedValue(new Error(`provider may have charged ${SECRET}`));
    retried(await deliver(bodyFor(id)));
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toMatchObject({ status: 'needs_review', result_text: null });
    expect((await row(id)).provider_attempt_id).toBeTruthy();
    expect(runAI).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(SECRET);
  });
  it.each([false, true])('调用标记写入失败（已提交=%s）时绝不发送请求', async afterCommit => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, DB: failingDb('SET provider_attempt_id =', afterCommit) }));
    expect(runAI).not.toHaveBeenCalled();
    now += LEASE_MS + 1;
    const m = await deliver(bodyFor(id));
    if (afterCommit) {
      retried(m);
      expect((await row(id)).status).toBe('needs_review');
      expect(runAI).not.toHaveBeenCalled();
    } else {
      expect(m.ack).toHaveBeenCalledOnce();
      expect(runAI).toHaveBeenCalledOnce();
    }
  });
  it.each([false, true])('结果落库响应失败（已提交=%s）不盲重调、不提前 ack', async afterCommit => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, DB: failingDb("SET status = 'succeeded'", afterCommit) }));
    expect((await row(id)).status).toBe(afterCommit ? 'succeeded' : 'needs_review');
    const m = await deliver(bodyFor(id));
    if (afterCommit) expect(m.ack).toHaveBeenCalledOnce(); else retried(m);
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('保存结果和待核查状态均失败，持久化调用标记仍阻止再次付费', async () => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, DB: failingDb('provider_attempt_id = ? AND status IN', false, true) }));
    expect((await row(id)).status).toBe('running');
    now += LEASE_MS + 1;
    retried(await deliver(bodyFor(id)));
    expect((await row(id)).status).toBe('needs_review');
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('D1 查询故障只重试本条消息，不输出底层异常', async () => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, DB: failingDb('FROM photos') }));
    expect(runAI).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(SECRET);
  });
});

describe('Workers AI 有界响应与超时', () => {
  it.each(['not-json', '{}', JSON.stringify(completion('')), JSON.stringify(completion(123)), JSON.stringify(completion('x'.repeat(16001))), 'x'.repeat(128 * 1024 + 1)])('无效/过大响应拒绝为不确定结果：%#', async text => {
    const { id } = await seed();
    runAI.mockResolvedValueOnce(new Response(text));
    retried(await deliver(bodyFor(id)));
    expect((await row(id)).status).toBe('needs_review');
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('超时会 abort，不自动重试 AI binding', async () => {
    let signal: AbortSignal | undefined;
    runAI.mockImplementation((_model, _input, options) => { signal = options.signal; return new Promise(() => {}); });
    await expect(caption('data:image/jpeg;base64,AA==', env.AI, 10))
      .rejects.toMatchObject({ code: 'provider_timeout' });
    expect(signal!.aborted).toBe(true);
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('超时覆盖已返回 headers 但卡住的响应正文', async () => {
    const cancel = vi.fn();
    runAI.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    await expect(caption('data:image/jpeg;base64,AA==', env.AI, 10))
      .rejects.toMatchObject({ code: 'provider_timeout' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(runAI).toHaveBeenCalledOnce();
  });
});

describe('数据库不变量与快照', () => {
  it('依次迁移后的完整结构与 schema.sql 快照完全一致', async () => {
    const snapshot = await mf.getD1Database('SNAPSHOT');
    const sql = (await readFile('../../skills/deploy_cloudflare/references/schema.sql', 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(x => x.trim())) await snapshot.prepare(statement).run();
    const query = `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name`;
    expect((await snapshot.prepare(query).all()).results).toEqual((await db.prepare(query).all()).results);
  });
  it('唯一键、外键与状态约束在真实 D1 生效', async () => {
    const { id } = await seed();
    await deliver(bodyFor(id));
    await expect(db.prepare('INSERT INTO photo_analyses SELECT * FROM photo_analyses WHERE photo_id = ?').bind(id).run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM photos WHERE photo_id = ?').bind(id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE photo_analyses SET result_text = NULL WHERE photo_id = ?").bind(id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE photo_analyses SET status = 'retry_wait', result_text = NULL WHERE photo_id = ?").bind(id).run()).rejects.toThrow();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});


describe('结构化诊断日志', () => {
  const logs = () => [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls].map(args => args[0] as any);
  it('记录阶段边界、实际耗时、图片字节数与文字长度，不伪造 CPU 计时', async () => {
    const { id, key } = await seed();
    runAI.mockImplementationOnce(async () => { now += 1500; return ok(); });
    await deliver(bodyFor(id));
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'stage_start', stage: 'encode_image' }));
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'stage_end', stage: 'call_provider', stage_wall_ms: 1500 }));
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'message_ack', photo_id: id, elapsed_wall_ms: 1500, result_chars: 9 }));
    const output = JSON.stringify(logs());
    for (const forbidden of [SECRET, key, '一张合成测试图片。', 'data:image/', 'cpu_ms']) expect(output).not.toContain(forbidden);
  });
  it('捕获模型超时后，先输出失败阶段，再持久化 needs_review', async () => {
    const { ProviderUncertain } = await import('../src/workers-ai');
    const { id } = await seed();
    runAI.mockImplementationOnce(async () => { now += 45000; throw new ProviderUncertain('provider_timeout'); });
    retried(await deliver(bodyFor(id)));
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'operation_failed', stage: 'call_provider', code: 'provider_timeout', elapsed_wall_ms: 45000, timeout_ms: 45000 }));
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'message_retry', code: 'provider_timeout', status: 'needs_review' }));
  });
  it('存储故障定位阶段且不记录原始异常，坏消息不进入日志', async () => {
    const { id } = await seed();
    retried(await deliver(bodyFor(id), { ...env, DB: failingDb('FROM photos') }));
    retried(await deliver({ raw_secret: SECRET, photo_id: `malicious-${SECRET}` }));
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'operation_failed', stage: 'load_photo', code: 'storage_or_processing_error' }));
    expect(JSON.stringify(logs())).not.toContain(SECRET);
  });
});


describe('Gemma 版本与完整输出', () => {
  it('v2 另建结果，历史 v1 保持原模型和文字不变', async () => {
    const { id } = await seed();
    await db.prepare(`INSERT INTO photo_analyses
      (photo_id, analysis_version, model, status, next_attempt_at_ms, provider_attempt_id,
       provider_submitted_at_ms, result_text, created_at_ms, updated_at_ms)
      VALUES (?, 'v1', 'moondream3.1-9B-A2B', 'succeeded', ?, 'history-attempt', ?, '历史结果', ?, ?)`)
      .bind(id, now, now, now, now).run();
    expect((await deliver(bodyFor(id))).ack).toHaveBeenCalledOnce();
    expect(await row(id)).toMatchObject({ analysis_version: 'v2', model: MODEL, status: 'succeeded' });
    expect(await db.prepare("SELECT model, result_text FROM photo_analyses WHERE photo_id=? AND analysis_version='v1'").bind(id).first())
      .toEqual({ model: 'moondream3.1-9B-A2B', result_text: '历史结果' });
    expect(runAI).toHaveBeenCalledOnce();
  });
  it('同版本已登记其他模型时禁止静默覆盖或调用', async () => {
    const { id } = await seed();
    await db.prepare(`INSERT INTO photo_analyses
      (photo_id, analysis_version, model, next_attempt_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, 'v2', 'unexpected-model', ?, ?, ?)`).bind(id, now, now, now).run();
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toMatchObject({ model: 'unexpected-model', attempt_count: 0 });
    expect(runAI).not.toHaveBeenCalled();
  });
  it.each(['length', 'content_filter', 'tool_calls'])('不把 %s 结束的输出存成成功', async reason => {
    const { id } = await seed();
    runAI.mockResolvedValueOnce(Response.json(completion('可能不完整的内容', reason)));
    retried(await deliver(bodyFor(id)));
    expect(await row(id)).toMatchObject({ status: 'needs_review', error_code: 'provider_incomplete_response', result_text: null });
    retried(await deliver(bodyFor(id)));
    expect(runAI).toHaveBeenCalledOnce();
  });
});
