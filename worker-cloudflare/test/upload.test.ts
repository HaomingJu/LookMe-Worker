import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { encode } from 'jpeg-js';
import worker from '../src/index';

const TOKEN = 'lm_' + 'a'.repeat(64);
const OTHER_TOKEN = 'lm_' + 'b'.repeat(64);
const tokenHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
const image = (value = 120, width = 2, height = 2) => new Uint8Array(encode({ width, height, data: new Uint8Array(width * height * 4).fill(value) }, 80).data);
function form(id = crypto.randomUUID(), bytes = image(), metadata: Record<string, string> = {}) {
  const data = new FormData();
  data.set('client_photo_id', id);
  data.set('source', 'cli');
  data.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'private-name.jpg');
  for (const [key, value] of Object.entries(metadata)) data.set(key, value);
  return data;
}
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const upload = async (body: FormData, token: string | null = TOKEN) => {
  const request = new Request('http://localhost/photos', { method: 'POST', body, headers: token === null ? {} : { Authorization: `Bearer ${token}` } });
  return mf.dispatchFetch(request.url, { method: 'POST', body: await request.arrayBuffer(), headers: Object.fromEntries(request.headers) });
};
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-19',
    d1Databases: ['DB'], r2Buckets: ['PHOTOS'] }));
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('PHOTOS');
  // D1 exec 不解析多行语句，按本项目迁移的分号切分。
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(s => s.trim())) await db.prepare(statement).run();
  }
  for (const [user, token] of [['test-owner', TOKEN], ['other-owner', OTHER_TOKEN]]) {
    await db.prepare('INSERT INTO users (user_id, created_at_ms) VALUES (?, ?)').bind(user, Date.now()).run();
    await db.prepare('INSERT INTO user_tokens (token_id, user_id, token_hash, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), user, await tokenHash(token), Date.now(), Date.now() + 86400000).run();
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe('本地真实 D1/R2 上传', () => {
  it('首传保存 JPEG 和元数据；同请求重传不新增对象，且响应不泄露对象键', async () => {
    const id = crypto.randomUUID();
    const metadata = { captured_at: '2026-11-19T15:30:00+08:00', captured_at_source: 'exif' };
    const first = await upload(form(id, image(), metadata));
    expect(first.status).toBe(201);
    const result = await first.json() as any;
    expect(result.captured_at).toBe('2026-11-19T07:30:00.000Z');
    expect(Object.keys(result).sort()).toEqual(['captured_at', 'photo_id', 'uploaded_at']);
    const row = await db.prepare('SELECT * FROM photos WHERE photo_id=?').bind(result.photo_id).first() as any;
    expect(row.owner_id).toBe('test-owner');
    expect(row.width).toBe(2);
    expect(row.sha256).toHaveLength(64);
    const object = await bucket.get(row.object_key);
    expect(object!.httpMetadata.contentType).toBe('image/jpeg');
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(image());
    const second = await upload(form(id, image(), metadata));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(result);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE client_photo_id=?').bind(id).first() as any).n).toBe(1);
    expect((await bucket.list({ prefix: `photos/v1/test-owner/${result.photo_id}/` })).objects).toHaveLength(1);
  });
  it('同 ID 换字节或关键元数据返回 409', async () => {
    const id = crypto.randomUUID();
    expect((await upload(form(id))).status).toBe(201);
    expect((await upload(form(id, image(20)))).status).toBe(409);
    expect((await upload(form(id, image(), { source: 'device' }))).status).toBe(409);
  });
  it('缺失或错误凭据返回 401', async () => {
    expect((await upload(form(), null)).status).toBe(401);
    expect((await upload(form(), 'wrong')).status).toBe(401);
  });
  it('拒绝伪造 owner、重复字段及非法 UUID', async () => {
    expect((await upload(form(undefined, image(), { owner_id: 'other' }))).status).toBe(400);
    const data = form(); data.append('source', 'cli');
    expect((await upload(data)).status).toBe(400);
    expect((await upload(form('bad-id'))).status).toBe(400);
  });
  it('拒绝错误日期、无时区及拍摄时间字段不成对', async () => {
    for (const metadata of [
      { captured_at: '2026-02-30T10:00:00Z', captured_at_source: 'manual' },
      { captured_at: '2026-11-19T10:00:00', captured_at_source: 'manual' },
      { captured_at: '2026-11-19T10:00:00Z' },
    ]) expect((await upload(form(undefined, image(), metadata))).status).toBe(400);
  });
  it('拒绝空文件、非 JPEG、伪造文件头和不可解码 JPEG', async () => {
    expect((await upload(form(undefined, new Uint8Array()))).status).toBe(400);
    expect((await upload(form(undefined, new Uint8Array([1, 2, 3])))).status).toBe(415);
    expect((await upload(form(undefined, new Uint8Array([255, 216, 255, 217])))).status).toBe(415);
    const broken = image().slice(); broken.fill(0, 20, 100);
    expect((await upload(form(undefined, broken))).status).toBe(415);
  });
  it('拒绝文件超限、边长超限和无 Content-Length 的超大请求', async () => {
    expect((await upload(form(undefined, new Uint8Array(2 * 1024 * 1024 + 1)))).status).toBe(413);
    expect((await upload(form(undefined, image(100, 2049, 1)))).status).toBe(413);
    const response = await mf.dispatchFetch('http://localhost/photos', { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'multipart/form-data; boundary=x' },
      body: new Uint8Array(3 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
  });
  it('并发同请求仅产生一条 D1 记录', async () => {
    const id = crypto.randomUUID();
    const responses = await Promise.all([upload(form(id)), upload(form(id))]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE client_photo_id=?').bind(id).first() as any).n).toBe(1);
  });
  it('不同用户同一客户端 UUID 各自独立，不能覆盖或复用他人的照片', async () => {
    const id = crypto.randomUUID();
    const first = await upload(form(id));
    const firstPhoto = await first.json() as any;
    const second = await upload(form(id, image(20)), OTHER_TOKEN);
    expect(second.status).toBe(201);
    const secondPhoto = await second.json() as any;
    expect(secondPhoto.photo_id).not.toBe(firstPhoto.photo_id);
    const rows = (await db.prepare('SELECT owner_id, object_key FROM photos WHERE client_photo_id=?').bind(id).all()).results;
    expect(rows.map((r: any) => r.owner_id).sort()).toEqual(['other-owner', 'test-owner']);
    expect(rows.every((r: any) => r.object_key.startsWith(`photos/v1/${r.owner_id}/`))).toBe(true);
    expect((await upload(form(id, image(20)))).status).toBe(409);
    expect((await upload(form(id, image(20)), OTHER_TOKEN)).status).toBe(200);
  });
  it('拒绝过期、撤销、停用用户和不存在的 Token，且不写入照片', async () => {
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM photos').first() as any).n;
    for (const [index, status] of ['expired', 'revoked', 'disabled'].entries()) {
      const user = `blocked-${index}`;
      const token = 'lm_' + String(index + 1).repeat(64);
      const created = Date.now() - 10000;
      await db.prepare('INSERT INTO users (user_id, status, created_at_ms) VALUES (?, ?, ?)').bind(user, status === 'disabled' ? 'disabled' : 'active', created).run();
      await db.prepare('INSERT INTO user_tokens (token_id, user_id, token_hash, created_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), user, await tokenHash(token), created, status === 'expired' ? created + 1 : Date.now() + 86400000, status === 'revoked' ? Date.now() : null).run();
      expect((await upload(form(), token)).status).toBe(401);
    }
    expect((await upload(form(), 'lm_' + 'f'.repeat(64))).status).toBe(401);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM photos').first() as any).n).toBe(before);
  });
  it('用户的多个 Token 均可用，撤销其中一个不影响另一个', async () => {
    const token = 'lm_' + 'c'.repeat(64);
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO user_tokens (token_id, user_id, token_hash, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'other-owner', await tokenHash(token), Date.now(), Date.now() + 86400000).run();
    expect((await upload(form(), token)).status).toBe(201);
    await db.prepare('UPDATE user_tokens SET revoked_at_ms=? WHERE token_id=?').bind(Date.now(), id).run();
    expect((await upload(form(), token)).status).toBe(401);
    expect((await upload(form(), OTHER_TOKEN)).status).toBe(201);
  });
  it('未知路由 404；错误方法 405', async () => {
    expect((await mf.dispatchFetch('http://localhost/unknown')).status).toBe(404);
    const response = await mf.dispatchFetch('http://localhost/photos');
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

it('R2 写失败不得写入 D1；D1 失败不得报告成功，也不盲删 R2 对象', async () => {
  for (const failR2 of [true, false]) {
    let inserts = 0;
    let puts = 0;
    let deletes = 0;
    const env = {
      DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes('JOIN users') ? { user_id: 'test-owner' } : null,
        run: async () => { inserts++; throw new Error('db unavailable'); } }) }) },
      PHOTOS: { put: async () => { puts++; if (failR2) throw new Error('r2 unavailable'); return {}; }, delete: async () => { deletes++; } },
    };
    const response = await worker.fetch(new Request('http://localhost/photos', { method: 'POST', body: form(), headers: { Authorization: `Bearer ${TOKEN}` } }), env as any);
    expect(response.status).toBe(503);
    expect(puts).toBe(1);
    expect(inserts).toBe(failR2 ? 0 : 1);
    expect(deletes).toBe(0);
  }
});
