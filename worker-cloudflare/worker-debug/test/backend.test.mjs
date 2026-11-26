import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const BASE_URL = 'https://localhost';
const PASSWORD = 'local-backend-fixture';
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const EMPTY_OWNER = '00000000-0000-4000-8000-000000000003';
const project = fileURLToPath(new URL('../', import.meta.url));
const migrations = new URL('../../worker-upload/migrations/', import.meta.url);
const capturedDay = '2026-11-20';
const uploadDay = '2026-11-21';
const capturedAt = time => Date.parse(`${capturedDay}T${time}+08:00`);
const uploadedAt = time => Date.parse(`${uploadDay}T${time}+08:00`);
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
let mf;
let db;
let bucket;
let comics;
let session;

async function addPhoto(number, capture, upload = uploadedAt('12:00:00'), owner = OWNER) {
  const photoId = id(number);
  const objectKey = `fixtures/${photoId}.jpg`;
  await bucket.put(objectKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  await db.prepare(`INSERT INTO photos
    (photo_id, owner_id, client_photo_id, object_key, sha256, byte_size, width, height,
     source, captured_at_ms, captured_at_source, uploaded_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(photoId, owner, randomUUID(), objectKey, 'a'.repeat(64), 4, 1, 1,
      'cli', capture, capture === null ? null : 'manual', upload).run();
  return photoId;
}

async function fetchJSON(path, authenticated = true) {
  const response = await mf.dispatchFetch(`${BASE_URL}${path}`, {
    headers: authenticated ? { Cookie: session } : {},
  });
  return { response, body: await response.json() };
}

function timeline(parameters = {}) {
  const query = new URLSearchParams({ user: OWNER, date: capturedDay, ...parameters });
  return fetchJSON(`/api/timeline?${query}`);
}

describe('拍摄时间筛选：本地真实 D1/R2', { concurrency: false }, () => {
  before(async () => {
    const bundle = await build({
      absWorkingDir: project,
      entryPoints: ['src/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      loader: { '.html': 'text', '.css': 'text', '.js': 'text' },
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-11-19',
      d1Databases: ['DB'],
      r2Buckets: ['PHOTOS', 'COMICS'],
      d1Persist: false,
      r2Persist: false,
      bindings: { DEBUG_PASSWORD: PASSWORD },
      outboundService: () => { throw new Error('测试禁止公网请求'); },
    }));
    db = await mf.getD1Database('DB');
    bucket = await mf.getR2Bucket('PHOTOS');
    comics = await mf.getR2Bucket('COMICS');
    for (const filename of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = (await readFile(new URL(filename, migrations), 'utf8')).replace(/--[^\n]*/g, '');
      for (const statement of sql.split(';').filter(value => value.trim())) await db.prepare(statement).run();
    }
    const login = await mf.dispatchFetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    session = login.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(session?.startsWith('lookme_debug='));
  }, { timeout: 30000 });

  beforeEach(async () => {
    await db.prepare('DELETE FROM comic_runs').run();
    await db.prepare('DELETE FROM stories').run();
    await db.prepare('DELETE FROM story_run_photos').run();
    await db.prepare('DELETE FROM story_runs').run();
    await db.prepare('DELETE FROM photos').run();
    await db.prepare('DELETE FROM users').run();
    for (const [index, user] of [OWNER, OTHER_OWNER, EMPTY_OWNER].entries()) {
      const username = { [OWNER]: 'owner-one', [OTHER_OWNER]: 'owner-two' }[user] ?? null;
      await db.prepare('INSERT INTO users (user_id, username, created_at_ms) VALUES (?, ?, ?)')
        .bind(user, username, 1700000000000 + index).run();
    }
  });

  after(async () => { await mf?.dispose(); });

  it('按实际拍摄日期筛选，不按上传日期归档', async () => {
    const capturedPhoto = await addPhoto(1, capturedAt('08:00:00'));
    const uploadedOnlyPhoto = await addPhoto(2, Date.parse('2026-11-19T08:00:00+08:00'));
    const captureDay = await timeline();
    assert.equal(captureDay.response.status, 200);
    assert.equal(captureDay.body.date_basis, 'captured_at_ms');
    assert.equal(captureDay.body.timezone, 'Asia/Shanghai');
    assert.deepEqual(captureDay.body.photos.map(photo => photo.photo_id), [capturedPhoto]);
    assert.equal(captureDay.body.photos[0].uploaded_at_ms, uploadedAt('12:00:00'));
    assert.equal(captureDay.body.photos[0].captured_at_ms, capturedAt('08:00:00'));
    const uploadDate = await timeline({ date: uploadDay });
    assert.equal(uploadDate.response.status, 200);
    assert.deepEqual(uploadDate.body.photos, []);
    assert.ok(!captureDay.body.photos.some(photo => photo.photo_id === uploadedOnlyPhoto));
  });

  it('缺失拍摄时间的照片不回退为上传时间，也不混入筛选结果', async () => {
    const datedPhoto = await addPhoto(3, capturedAt('09:00:00'), capturedAt('10:00:00'));
    const undatedPhoto = await addPhoto(4, null, capturedAt('09:00:00'));
    const result = await timeline();
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.photos.map(photo => photo.photo_id), [datedPhoto]);
    assert.ok(!result.body.photos.some(photo => photo.photo_id === undatedPhoto));
    await db.prepare('DELETE FROM photos WHERE photo_id = ?').bind(datedPhoto).run();
    const onlyUndated = await timeline();
    assert.equal(onlyUndated.response.status, 200);
    assert.deepEqual(onlyUndated.body.photos, []);
    assert.equal(onlyUndated.body.total, 0);
  });

  it('北京时间范围含结束分钟，排除范围外及其他用户的照片', async () => {
    const first = await addPhoto(5, capturedAt('08:30:00'));
    const last = await addPhoto(6, capturedAt('08:30:59.999'));
    await addPhoto(7, capturedAt('08:29:59.999'));
    await addPhoto(8, capturedAt('08:31:00'));
    await addPhoto(9, capturedAt('08:30:20'), uploadedAt('12:00:00'), OTHER_OWNER);
    const result = await timeline({ start: '08:30', end: '08:30' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.photos.map(photo => photo.photo_id), [first, last]);
    await addPhoto(10, capturedAt('23:59:59.999'));
    await addPhoto(11, Date.parse('2026-11-21T00:00:00+08:00'));
    const dayEnd = await timeline({ start: '23:59', end: '23:59' });
    assert.equal(dayEnd.response.status, 200);
    assert.deepEqual(dayEnd.body.photos.map(photo => photo.photo_id), [id(10)]);
  });

  it('同毫秒拍摄的照片按 ID 排序分页，上传顺序不同也无重复或遗漏', async () => {
    const capture = capturedAt('10:00:00');
    const expected = [id(12), id(13), id(14), id(15), id(16)];
    for (const [index, number] of [16, 13, 15, 12, 14].entries()) {
      await addPhoto(number, capture, uploadedAt(`12:0${index}:00`));
    }
    const collected = [];
    let offset = 0;
    let pageCount = 0;
    do {
      const result = await timeline({ limit: '2', offset: String(offset) });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.date_basis, 'captured_at_ms');
      assert.ok(result.body.photos.length <= 2);
      collected.push(...result.body.photos.map(photo => photo.photo_id));
      offset += result.body.photos.length;
      pageCount++;
      assert.ok(pageCount <= 3);
    } while (offset < expected.length);
    assert.deepEqual(collected, expected);
    assert.equal(new Set(collected).size, expected.length);
    assert.equal(pageCount, 3);
  });

  it('1970 年前的负 Unix 拍摄时间可筛选和分页', async () => {
    const oldCapture = Date.parse('1960-01-02T09:00:00+08:00');
    assert.ok(oldCapture < 0);
    await addPhoto(23, oldCapture);
    await addPhoto(24, oldCapture + 60000);
    const first = await timeline({ date: '1960-01-02', limit: '1', offset: '0' });
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.photos.map(photo => photo.photo_id), [id(23)]);
    assert.equal(first.body.total, 2);
    const second = await timeline({ date: '1960-01-02', limit: '1', offset: '1' });
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body.photos.map(photo => photo.photo_id), [id(24)]);
    assert.equal(second.body.total, 2);
  });

  it('非法 offset 被拒绝', async () => {
    const result = await timeline({ offset: '-1' });
    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, { error: 'invalid_offset' });
  });

  it('不传日期显示该用户全部照片，含缺拍摄时间的', async () => {
    const dated = await addPhoto(30, capturedAt('08:00:00'));
    const undated = await addPhoto(31, null, uploadedAt('10:00:00'));
    const result = await fetchJSON(`/api/timeline?user=${OWNER}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.total, 2);
    assert.deepEqual(result.body.photos.map(p => p.photo_id), [dated, undated]);
  });

  it('用户列表保留上传统计，并准确给出拍摄时间和未标注计数', async () => {
    const firstCapture = capturedAt('08:00:00');
    const lastCapture = Date.parse('2026-11-19T23:59:00+08:00');
    await addPhoto(18, firstCapture, uploadedAt('12:00:00'));
    await addPhoto(19, lastCapture, uploadedAt('14:00:00'));
    await addPhoto(20, null, uploadedAt('16:00:00'));
    await addPhoto(21, null, uploadedAt('18:00:00'), OTHER_OWNER);
    const result = await fetchJSON('/api/users');
    assert.equal(result.response.status, 200);
    const owner = result.body.users.find(user => user.user_id === OWNER);
    assert.equal(owner.photo_count, 3);
    assert.equal(owner.first_uploaded_at_ms, uploadedAt('12:00:00'));
    assert.equal(owner.last_uploaded_at_ms, uploadedAt('16:00:00'));
    assert.equal(owner.first_captured_at_ms, lastCapture);
    assert.equal(owner.last_captured_at_ms, firstCapture);
    assert.equal(owner.undated_photo_count, 1);
    const undatedOwner = result.body.users.find(user => user.user_id === OTHER_OWNER);
    assert.equal(undatedOwner.photo_count, 1);
    assert.equal(undatedOwner.first_captured_at_ms, null);
    assert.equal(undatedOwner.last_captured_at_ms, null);
    assert.equal(undatedOwner.undated_photo_count, 1);
    const emptyOwner = result.body.users.find(user => user.user_id === EMPTY_OWNER);
    assert.equal(emptyOwner.photo_count, 0);
    assert.equal(emptyOwner.first_captured_at_ms, null);
    assert.equal(emptyOwner.last_captured_at_ms, null);
    assert.equal(emptyOwner.undated_photo_count, 0);
  });

  it('用户名可替代 user_id 定位用户，且大小写不敏感', async () => {
    const photo = await addPhoto(30, capturedAt('08:00:00'));
    const byName = await timeline({ user: 'owner-one' });
    assert.equal(byName.response.status, 200);
    assert.deepEqual(byName.body.photos.map(p => p.photo_id), [photo]);
    const byCase = await timeline({ user: 'OWNER-ONE' });
    assert.equal(byCase.response.status, 200);
    assert.deepEqual(byCase.body.photos.map(p => p.photo_id), [photo]);
    assert.equal((await fetchJSON(`/api/stories?user=owner-one&date=${uploadDay}`)).response.status, 200);
    assert.equal((await fetchJSON(`/api/timeline?user=nobody&date=${capturedDay}`)).response.status, 404);
    const users = (await fetchJSON('/api/users')).body.users;
    assert.equal(users.find(u => u.user_id === OWNER).username, 'owner-one');
  });

  it('漫画接口按上传日读取成功结果并返回图片', async () => {
    const { runId } = await seedRun(1);
    const storyId = id(40), comicRunId = id(41);
    await db.prepare(`INSERT INTO stories (story_id, owner_id, run_id, position, title, summary, image_prompt, panels_json, source_photo_ids_json, created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(storyId, OWNER, runId, 0, '漫画故事', '摘要', '提示词', '[1,2,3,4]', '["missing-photo"]', uploadedAt('12:00:00')).run();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const key = `comic-runs/v1/${'a'.repeat(64)}/${comicRunId}`;
    await comics.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
    await db.prepare(`INSERT INTO comic_runs (owner_id, run_id, story_id, model, profile_version, profile_json, request_sha256, input_json, status, result_object_key, result_mime_type, result_byte_size, result_sha256, result_width, result_height, created_at_ms, updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(OWNER, comicRunId, storyId, 'local-model', 'v1', '{}', 'c'.repeat(64), '{}', 'succeeded', key, 'image/png', bytes.length, 'd'.repeat(64), 2, 2, uploadedAt('12:00:00'), uploadedAt('12:00:00')).run();
    const list = await fetchJSON(`/api/comics?user=${OWNER}&date=${uploadDay}`);
    assert.equal(list.response.status, 200);
    assert.equal(list.body.comics.length, 1);
    assert.equal(list.body.comics[0].run_id, comicRunId);
    assert.equal(list.body.comics[0].title, '漫画故事');
    assert.equal(list.body.comics[0].width, 2);
    const all = await fetchJSON(`/api/comics?user=${OWNER}`);
    assert.equal(all.response.status, 200);
    assert.equal(all.body.comics.length, 1);
    assert.equal(all.body.comics[0].run_id, comicRunId);
    const img = await mf.dispatchFetch(`${BASE_URL}/comic/${comicRunId}?user=${OWNER}`, { headers: { Cookie: session } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('Content-Type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [...bytes]);
  });

  it('停用用户不出现在用户列表，但用户名仍可被直接查询', async () => {
    await db.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(OTHER_OWNER).run();
    const result = await fetchJSON('/api/users');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.users.some(u => u.user_id === OTHER_OWNER), false);
    assert.equal(result.body.users.some(u => u.user_id === OWNER), true);
  });

  async function seedRun(number, user=OWNER, status='succeeded') {
    const runId=`30000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
    const result={run_id:runId,story_count:1,daily_summary:'合成故事摘要',model:'local-model',story_version:'v5',
      request_duration_ms:1234,model_timings:{total_ms:1000},usage:{prompt_tokens:10,completion_tokens:20},
      cost:{estimated_usd:0.0001,currency:'USD',is_estimate:true,pricing:{input:0.45,output:3.2,source:'https://developers.cloudflare.com/'}},
      stories:[{story_id:id(number),title:'合成故事',summary:'合成文案',image_prompt:'合成提示词',source_photo_ids:[],panels:[]}]};
    await db.prepare(`INSERT INTO story_runs(run_id,owner_id,story_date,timezone,date_basis,story_version,analysis_version,model,input_sha256,input_json,profile_json,status,response_json,created_at_ms,updated_at_ms)
      VALUES (?,?,'2026-11-21','Asia/Shanghai','uploaded_at_ms','v5','v2','local-model',?,'{}','{}',?,?,?,?)`)
      .bind(runId,user,'f'.repeat(64),status,status==='succeeded'?JSON.stringify(result):null,uploadedAt('12:00:00'),uploadedAt('12:00:00')).run();
    return {runId,result};
  }
  it('故事查询按上传日隔离用户、游标分页，不返回私密输入快照',async()=>{
    for(let i=1;i<=12;i++)await seedRun(i);
    await seedRun(20,OTHER_OWNER);
    const query=`/api/stories?user=${OWNER}&date=${uploadDay}`;
    const first=await fetchJSON(query);assert.equal(first.response.status,200);assert.equal(first.body.runs.length,10);
    assert.equal(first.body.date_basis,'uploaded_at_ms');assert.equal(first.body.runs[0].model,'local-model');
    assert.equal(first.body.runs[0].cost.estimated_usd,0.0001);assert.equal(first.body.runs[0].input_json,undefined);
    const second=await fetchJSON(query+'&cursor='+encodeURIComponent(first.body.next_cursor));
    assert.equal(second.body.runs.length,2);assert.equal(second.body.next_cursor,null);
    assert.equal(new Set([...first.body.runs,...second.body.runs].map(r=>r.run_id)).size,12);
    const wrong=await fetchJSON(`/api/stories?user=${OTHER_OWNER}&date=${uploadDay}&cursor=${encodeURIComponent(first.body.next_cursor)}`);assert.equal(wrong.response.status,400);
    assert.equal((await fetchJSON(`/api/stories?user=${OWNER}&date=${capturedDay}`)).body.runs.length,0);
    const all=await fetchJSON(`/api/stories?user=${OWNER}`);assert.equal(all.response.status,200);assert.equal(all.body.runs.length,10);assert.equal(all.body.runs[0].model,'local-model');
  });
  it('故事详情保持鉴权和owner约束，支持ETag，未完成批次不伪装成功',async()=>{
    const {runId,result}=await seedRun(1);
    const url=`/api/story?user=${OWNER}&run_id=${runId}`;
    assert.equal((await fetchJSON(url,false)).response.status,401);
    assert.equal((await fetchJSON(`/api/stories?user=${OWNER}&date=${uploadDay}`,false)).response.status,401);
    assert.equal((await fetchJSON(`/api/story?user=${OTHER_OWNER}&run_id=${runId}`)).response.status,404);
    const detail=await fetchJSON(url);assert.deepEqual(detail.body.result,result);
    const cached=await mf.dispatchFetch(BASE_URL+url,{headers:{Cookie:session,'If-None-Match':detail.response.headers.get('ETag')}});assert.equal(cached.status,304);
    const pending=await seedRun(2,OWNER,'generating');
    assert.equal((await fetchJSON(`/api/story?user=${OWNER}&run_id=${pending.runId}`)).body.result,null);
    assert.equal((await fetchJSON(`/api/stories?user=${OWNER}&date=2026-02-30`)).response.status,400);
    assert.equal((await fetchJSON(`/api/story?user=${OWNER}&run_id=bad`)).response.status,400);
  });
  it('拍摄时间改动不绕过现有登录保护', async () => {
    await addPhoto(22, capturedAt('08:00:00'));
    for (const route of ['/api/users', `/api/timeline?user=${OWNER}&date=${capturedDay}`, `/photo/${id(22)}`]) {
      const result = await fetchJSON(route, false);
      assert.equal(result.response.status, 401);
      assert.deepEqual(result.body, { error: 'unauthorized' });
    }
  });
});
