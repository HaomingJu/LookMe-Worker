import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { run } from '../scripts/comic.mjs';
import { defaultModel, models } from '../config/models.mjs';
import { comicPng, refJpeg } from './fixtures';

const tokens = { a: 'lm_' + 'a'.repeat(64), b: 'lm_' + 'b'.repeat(64), c: 'lm_' + 'c'.repeat(64) };
const story = randomUUID(), otherStory = randomUUID(), missingRefStory = randomUUID(), unlistedStory = randomUUID();
const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const otherPhoto = randomUUID(), unlistedPhoto = randomUUID();
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const original = Buffer.from(refJpeg, 'base64');
const metadata = Buffer.from('Exif\0\0SYNTHETIC_PRIVATE_LOCATION');
const jpg = Buffer.concat([original.subarray(0, 2),
  Buffer.from([0xff, 0xe1, 0, metadata.length + 2]), metadata, original.subarray(2)]);
let mf: Miniflare, db: D1Database, origin: string, temp: string, tokenFile: string;

beforeAll(async () => {
  const js = await build({ entryPoints: ['test/runtime-fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: js.outputFiles[0].text,
    compatibilityDate: '2026-11-19', d1Databases: { DB: 'comic-test' },
    r2Buckets: { PHOTOS: 'photos-test', COMICS: 'comics-test' },
    outboundService: () => { throw Error('No outbound network in tests'); } }));
  origin = (await mf.ready).origin;
  db = await mf.getD1Database('DB');
  const photos = await mf.getR2Bucket('PHOTOS');
  for (const file of (await fs.readdir('../worker-upload/migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const sql = (await fs.readFile(`../worker-upload/migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
    for (const query of sql.split(';').filter(x => x.trim())) await db.prepare(query).run();
  }
  for (const [letter, token] of Object.entries(tokens)) {
    const owner = `owner-${letter}`;
    await db.prepare('INSERT INTO users(user_id,created_at_ms) VALUES (?,1)').bind(owner).run();
    await db.prepare('INSERT INTO user_tokens(token_id,user_id,token_hash,created_at_ms,expires_at_ms) VALUES (?,?,?,1,?)')
      .bind(randomUUID(),owner,sha(token),Date.now()+3600000).run();
  }
  for (const [i, id] of [...ids, otherPhoto, unlistedPhoto].entries()) {
    const owner = id === otherPhoto ? 'owner-b' : id === unlistedPhoto ? 'owner-c' : 'owner-a', key = `synthetic/${id}`;
    if (i !== 3) await photos.put(key, jpg);
    await db.prepare(`INSERT INTO photos(photo_id,owner_id,client_photo_id,object_key,sha256,byte_size,width,height,source,uploaded_at_ms)
      VALUES (?,?,?,?,?,?,32,24,'cli',1)`).bind(id,owner,randomUUID(),key,sha(jpg),jpg.length).run();
  }
  for (const [id, owner, refs] of [[story,'owner-a',ids.slice(0,3)], [otherStory,'owner-b',[otherPhoto]], [missingRefStory,'owner-a',[ids[3]]], [unlistedStory,'owner-c',[unlistedPhoto]]] as const) {
    const storyRun = randomUUID();
    await db.prepare(`INSERT INTO story_runs(run_id,owner_id,story_date,timezone,date_basis,story_version,analysis_version,model,
      input_sha256,input_json,profile_json,status,response_json,created_at_ms,updated_at_ms)
      VALUES (?,?,'2026-11-25','Asia/Shanghai','upload','v5','v2','mock',?,'{}','{}','succeeded','{}',1,1)`)
      .bind(storyRun,owner,'0'.repeat(64)).run();
    const panels = [1,2,3,4].map(n => ({panel:n,description:'Synthetic panel',image_prompt:'Synthetic brief',source_photo_ids:[refs[(n-1)%refs.length]]}));
    await db.prepare(`INSERT INTO stories(story_id,owner_id,run_id,position,title,summary,image_prompt,panels_json,source_photo_ids_json,created_at_ms)
      VALUES (?,?,?,0,'Synthetic story','Synthetic summary','Comic page',?,?,1)`)
      .bind(id,owner,storyRun,JSON.stringify(panels),JSON.stringify(refs)).run();
  }
  temp = await fs.mkdtemp(path.join(os.tmpdir(),'lookme-comic-http-'));
  tokenFile = path.join(temp,'user.token');
  await fs.writeFile(tokenFile,tokens.a+'\n',{mode:0o600});
}, 30_000);

afterAll(async () => { await mf?.dispose(); if (temp) await fs.rm(temp,{recursive:true,force:true}); });
const headers = (token?: string) => ({ 'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}) });
const call = (resource: string, token?: string) => fetch(origin+resource,{headers:headers(token)});
const generate = (body: Record<string,unknown> = {}, token: string | null = tokens.a, failure = '') => fetch(origin+'/comics',{
  method:'POST', headers:{...headers(token??undefined),'X-Fixture-Error':failure},
  body:JSON.stringify({story_id:story,run_id:randomUUID(),model:defaultModel,confirm_model_call:true,...body}),
});
const getJson = async (response: Response) => ({code:response.status, body:await response.json() as any});
const cli = () => ['--base-url',origin,'--token-file',tokenFile];

describe('manual runtime / 手动运行', () => {
  it('routes the CLI through real local HTTP, D1 and R2 for all models; keeps distinct results', async () => {
    const resultIds = [];
    for (const model of models) {
      const result = await run(['generate',...cli(),'--story-id',story,'--model',model,'--confirm-model-call'],{notice:()=>{}});
      expect(result).toMatchObject({model,story_id:story,status:'succeeded',reference_photo_ids:ids.slice(0,3)});
      resultIds.push(result.run_id);
      expect(result.profile_version).toBe(model === models[2] ? 'comic-v2-flare-binding' : 'comic-v1');
      expect(result.image).toMatchObject({width:1024,height:1536,mime_type:'image/png'});
    }
    expect(new Set(resultIds).size).toBe(3);
    const history = await run(['list',...cli(),'--story-id',story]);
    expect(history.runs.map(r=>r.run_id)).toEqual(expect.arrayContaining(resultIds));
    const out = path.join(temp,'comic.png');
    await run(['download',...cli(),'--run-id',resultIds[0],'--out',out]);
    expect(await fs.readFile(out)).toEqual(Buffer.from(comicPng,'base64'));
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
    await expect(run(['download',...cli(),'--run-id',resultIds[0],'--out',out])).rejects.toThrow('cannot_save_new_image_file');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('coalesces concurrent identical run IDs and rejects changed inputs for that ID', async () => {
    const id = randomUUID();
    const requests = await Promise.all([generate({run_id:id}),generate({run_id:id})]);
    expect(requests.filter(r => r.status===201)).toHaveLength(1);
    expect(requests.filter(r => [200,202].includes(r.status))).toHaveLength(1);
    const repeated = await getJson(await generate({run_id:id}));
    expect(repeated).toMatchObject({code:200,body:{replayed:true,model_call_attempted:false}});
    expect(await getJson(await generate({run_id:id,model:models[1]}))).toMatchObject({code:409,body:{error:'run_id_conflict'}});
    const bucket = await mf.getR2Bucket('COMICS');
    expect((await bucket.list()).objects.filter(o=>o.key.endsWith(id))).toHaveLength(1);
  });

  it('blocks cross-owner story, history, status and file requests', async () => {
    const result = await getJson(await generate({photo_ids:[ids[1]]}));
    expect(result.body.reference_photo_ids).toEqual([ids[1]]);
    expect((await generate({},tokens.b)).status).toBe(404);
    expect((await call('/comics?story_id='+story,tokens.b)).status).toBe(404);
    expect((await call('/comics/'+result.body.run_id,tokens.b)).status).toBe(404);
    expect((await call(result.body.image.path,tokens.b)).status).toBe(404);
    expect((await call(result.body.image.path)).status).toBe(401);
  });

  it.each([
    [{confirm_model_call:false},'model_call_confirmation_required',400],
    [{model:'https://outside.invalid'},'unsupported_model',400],
    [{photo_ids:[otherPhoto]},'reference_not_in_story',422],
    [{photo_ids:[ids[0],ids[0]]},'invalid_reference_ids',400],
    [{story_id:missingRefStory},'reference_unavailable',409],
    [{owner_id:'owner-a'},'invalid_fields',400],
  ] as const)('rejects invalid input %j before calling the model',async (body,error,code) => {
    expect(await getJson(await generate({...body}))).toMatchObject({code,body:{error,model_call_attempted:false}});
  });

  it('requires an active token, enabled generation, owner allowlist and explicit Flare config', async () => {
    expect((await generate({},null)).status).toBe(401);
    expect((await generate({},tokens.c)).status).toBe(403);
    expect(await getJson(await generate({},tokens.a,'disabled'))).toMatchObject({code:503,body:{error:'comic_generation_disabled',model_call_attempted:false}});
    expect(await getJson(await generate({model:models[2]},tokens.a,'flare-disabled'))).toMatchObject({code:503,body:{error:'flare_disabled',model_call_attempted:false}});
  });

  it('can allow all authenticated dev users without exposing another owner’s stories', async () => {
    expect((await generate({story_id:unlistedStory},tokens.c)).status).toBe(403);
    expect(await getJson(await generate({story_id:unlistedStory},tokens.c,'allow-all-dev')))
      .toMatchObject({code:201,body:{status:'succeeded',story_id:unlistedStory,reference_photo_ids:[unlistedPhoto]}});
    expect(await getJson(await generate({},tokens.c,'allow-all-dev')))
      .toMatchObject({code:404,body:{error:'story_not_found',model_call_attempted:false}});
    expect((await generate({story_id:unlistedStory},'lm_'+'0'.repeat(64),'allow-all-dev')).status).toBe(401);
  });

  it('rejects generation without a migrated table before contacting a model', async () => {
    // An isolated name avoids altering the shared test database.
    const standalone = new Miniflare(convertV4MiniflareOptions({ modules: true,
      script: (await build({ entryPoints: ['test/runtime-fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text,
      compatibilityDate: '2026-11-19', d1Databases: { DB: 'missing-migration' }, r2Buckets: ['PHOTOS','COMICS'],
      outboundService: () => { throw Error('offline test'); } }));
    try {
      const isolated = await standalone.getD1Database('DB');
      await isolated.prepare("CREATE TABLE users (user_id TEXT, status TEXT)").run();
      await isolated.prepare("CREATE TABLE user_tokens (user_id TEXT, token_hash TEXT, revoked_at_ms INTEGER, expires_at_ms INTEGER)").run();
      await isolated.prepare("INSERT INTO users VALUES ('owner-a','active')").run();
      await isolated.prepare("INSERT INTO user_tokens VALUES ('owner-a',?,NULL,?)").bind(sha(tokens.a),Date.now()+3600000).run();
      const response = await standalone.dispatchFetch('https://localhost/comics', {
        method:'POST', headers:headers(tokens.a), body:JSON.stringify({story_id:story,run_id:randomUUID(),confirm_model_call:true}),
      });
      expect(await getJson(response)).toMatchObject({code:503,body:{model_call_attempted:false,may_have_been_billed:false}});
    } finally { await standalone.dispose(); }
  });

  it.each([
    ['flare-external','invalid_model_asset_url'], ['flare-credential-url','invalid_model_asset_url'],
    ['flare-r2-other-bucket','invalid_model_asset_url'], ['flare-redirect','model_asset_download_failed'], ['flare-oversize','model_asset_download_failed'],
    ['flare-corrupt','invalid_model_image'], ['flare-result-incomplete','invalid_model_response'],
  ])('fails closed for %s and retains a non-retryable run', async (fault, error) => {
    const run_id = randomUUID(), model = models[2];
    expect(await getJson(await generate({run_id,model},tokens.a,fault))).toMatchObject({
      code:502,body:{error,model_call_attempted:true,may_have_been_billed:true,automatic_retry:false}});
    expect(await getJson(await generate({run_id,model}))).toMatchObject({
      code:200,body:{status:'needs_review',model_call_attempted:false,image:null,replayed:true}});
  });

  it.each(['flare-r2', 'flare-r2-signed', 'flare-inline'])('persists a valid Flare asset with %s', async mode => {
    expect(await getJson(await generate({model:models[2]},tokens.a,mode))).toMatchObject({
      code:201,body:{status:'succeeded',image:{mime_type:'image/png',width:1024,height:1536}}});
  });

  it.each([['invalid',502,'invalid_model_image'],['timeout',504,'model_timeout'],['storage',503,'comic_persistence_unconfirmed']])(
    'records %s as needs_review and does not submit again', async (fault,code,error) => {
      const id = randomUUID();
      expect(await getJson(await generate({run_id:id},tokens.a,fault))).toMatchObject({
        code,body:{error,model_call_attempted:true,may_have_been_billed:true,automatic_retry:false}});
      expect(await getJson(await generate({run_id:id}))).toMatchObject({
        code:200,body:{status:'needs_review',model_call_attempted:false,image:null,replayed:true}});
      expect((await call('/comics/'+id+'/image',tokens.a)).status).toBe(409);
    });
});
