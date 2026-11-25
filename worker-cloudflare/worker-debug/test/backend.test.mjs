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
let comicsBucket;
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
    comicsBucket = await mf.getR2Bucket('COMICS');
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
      await db.prepare('INSERT INTO users (user_id, created_at_ms) VALUES (?, ?)')
        .bind(user, 1700000000000 + index).run();
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
    assert.equal(onlyUndated.body.next_cursor, null);
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

  it('同毫秒拍摄的照片按 ID 分页，上传顺序不同也无重复或遗漏', async () => {
    const capture = capturedAt('10:00:00');
    const expected = [id(12), id(13), id(14), id(15), id(16)];
    for (const [index, number] of [16, 13, 15, 12, 14].entries()) {
      await addPhoto(number, capture, uploadedAt(`12:0${index}:00`));
    }
    const collected = [];
    let cursor;
    let pageCount = 0;
    do {
      const result = await timeline({ limit: '2', ...(cursor ? { cursor } : {}) });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.date_basis, 'captured_at_ms');
      assert.ok(result.body.photos.length <= 2);
      collected.push(...result.body.photos.map(photo => photo.photo_id));
      cursor = result.body.next_cursor;
      if (cursor) {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        assert.equal(decoded.scope, `captured_at_ms|${OWNER}|${capturedDay}|00:00|23:59`);
        assert.equal(decoded.time, capture);
        assert.equal(decoded.id, result.body.photos.at(-1).photo_id);
      }
      pageCount++;
      assert.ok(pageCount <= 3);
    } while (cursor);
    assert.deepEqual(collected, expected);
    assert.equal(new Set(collected).size, expected.length);
    assert.equal(pageCount, 3);
  });

  it('1970 年前的负 Unix 拍摄时间可筛选和分页', async () => {
    const oldCapture = Date.parse('1960-01-02T09:00:00+08:00');
    assert.ok(oldCapture < 0);
    await addPhoto(23, oldCapture);
    await addPhoto(24, oldCapture + 60000);
    const first = await timeline({ date: '1960-01-02', limit: '1' });
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.photos.map(photo => photo.photo_id), [id(23)]);
    const decoded = JSON.parse(Buffer.from(first.body.next_cursor, 'base64').toString('utf8'));
    assert.equal(decoded.time, oldCapture);
    const second = await timeline({ date: '1960-01-02', limit: '1', cursor: first.body.next_cursor });
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body.photos.map(photo => photo.photo_id), [id(24)]);
    assert.equal(second.body.next_cursor, null);
  });

  it('旧上传时间游标被拒绝，不能用于拍摄时间筛选', async () => {
    await addPhoto(17, capturedAt('10:00:00'), capturedAt('11:00:00'));
    const cursor = Buffer.from(JSON.stringify({
      scope: `${OWNER}|${capturedDay}|00:00|23:59`,
      time: capturedAt('11:00:00'),
      id: id(17),
    })).toString('base64');
    const result = await timeline({ cursor });
    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, { error: 'invalid_cursor' });
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
  async function addComic(number, owner=OWNER, status='succeeded') {
    const sourcePhoto=await addPhoto(100+number, capturedAt('11:00:00'), uploadedAt('10:00:00'), owner);
    const runId=id(500+number), storyId=id(400+number), objectKey=`comic-fixtures/${runId}.png`;
    await db.prepare(`INSERT INTO story_runs(run_id,owner_id,story_date,timezone,date_basis,story_version,analysis_version,model,input_sha256,input_json,profile_json,status,response_json,created_at_ms,updated_at_ms)
      VALUES (?,?,'2026-11-21','Asia/Shanghai','uploaded_at_ms','v5','v2','@cf/qwen/qwen3.8-27b',?,'{}','{}','succeeded',?, ?, ?)`).bind(runId,owner,'f'.repeat(64),JSON.stringify({run_id:runId,story_count:1}),uploadedAt('10:00:00'),uploadedAt('10:00:00')).run();
    await db.prepare(`INSERT INTO stories(story_id,owner_id,run_id,position,title,summary,image_prompt,panels_json,source_photo_ids_json,created_at_ms)
      VALUES (?, ?, ?, 0, '测试故事', '测试摘要', '测试提示词', ?, ?, ?)`).bind(storyId,owner,runId,JSON.stringify([{panel:1,description:'a',image_prompt:'a',source_photo_ids:[sourcePhoto]} ,{panel:2,description:'b',image_prompt:'b',source_photo_ids:[sourcePhoto]},{panel:3,description:'c',image_prompt:'c',source_photo_ids:[sourcePhoto]},{panel:4,description:'d',image_prompt:'d',source_photo_ids:[sourcePhoto]}]),JSON.stringify([sourcePhoto]),uploadedAt('10:00:00')).run();
    const image={run_id:runId,story_id:storyId,model:'@cf/black-forest-labs/flux-2-klein-9b',profile_version:'v1',status,provider_request_id:'comic-provider',error_code:status==='succeeded'?null:'comic_error',created_at_ms:uploadedAt('10:00:00'),updated_at_ms:uploadedAt('10:01:00'),result_object_key:status==='succeeded'?objectKey:null,result_mime_type:status==='succeeded'?'image/png':null,result_byte_size:status==='succeeded'?4:null,result_sha256:status==='succeeded'?'b'.repeat(64):null,result_width:status==='succeeded'?1024:null,result_height:status==='succeeded'?1536:null};
    await db.prepare(`INSERT INTO comic_runs(owner_id,run_id,story_id,model,profile_version,profile_json,request_sha256,input_json,status,provider_request_id,result_object_key,result_mime_type,result_byte_size,result_sha256,result_width,result_height,error_code,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,'{}',?,'{}',?,?,?,?,?,?,?,?,?,?,?)`).bind(owner,runId,storyId,image.model,image.profile_version,'e'.repeat(64),status,image.provider_request_id,image.result_object_key,image.result_mime_type,image.result_byte_size,image.result_sha256,image.result_width,image.result_height,image.error_code,image.created_at_ms,image.updated_at_ms).run();
    if(status==='succeeded') await comicsBucket.put(objectKey,new Uint8Array([1,2,3,4]),{customMetadata:{sha256:'b'.repeat(64)},httpMetadata:{contentType:'image/png'}});
    return image;
  }
  it('漫画列表按用户/故事上传日隔离，返回模型和图片元信息且图片走私有绑定', async () => {
    const comic=await addComic(1); await addComic(2,OTHER_OWNER); await addComic(3,OWNER,'needs_review');
    const result=await fetchJSON(`/api/comics?user=${OWNER}&date=${uploadDay}`);
    assert.equal(result.response.status,200);assert.equal(result.body.runs.length,2);
    const success=result.body.runs.find(r=>r.run_id===comic.run_id);assert.equal(success.model,comic.model);assert.equal(success.profile_version,'v1');assert.equal(success.image.width,1024);assert.equal(success.image.height,1536);assert.equal(success.reference_photo_ids.length,0);
    const imageResponse=await mf.dispatchFetch(`${BASE_URL}${success.image.path}`,{headers:{Cookie:session}});assert.equal(imageResponse.status,200);assert.equal(imageResponse.headers.get('Content-Type'),'image/png');assert.equal((await imageResponse.arrayBuffer()).byteLength,4);
    assert.equal((await fetchJSON(`/api/comics?user=${OTHER_OWNER}&date=${uploadDay}`)).body.runs.length,1);
    assert.equal((await fetchJSON(`/api/comics?user=${OWNER}&date=${capturedDay}`)).body.runs.length,0);
  });
  it('漫画图片和列表需要会话，错误R2完整性返回503，未成功状态不能下载', async () => {
    const comic=await addComic(4);const path=`/api/comic/${comic.run_id}/image?user=${OWNER}`;
    assert.equal((await fetchJSON(path,false)).response.status,401);
    await comicsBucket.put('comic-fixtures/'+comic.run_id+'.png',new Uint8Array([9,9,9,9]),{customMetadata:{sha256:'wrong'}});
    assert.equal((await fetchJSON(path)).response.status,503);
    const pending=await addComic(5,OWNER,'needs_review');
    assert.equal((await fetchJSON(`/api/comic/${pending.run_id}/image?user=${OWNER}`)).response.status,404);
    assert.equal((await fetchJSON(`/api/comics?user=${OWNER}&date=2026-11-21`)).response.status,200);
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
