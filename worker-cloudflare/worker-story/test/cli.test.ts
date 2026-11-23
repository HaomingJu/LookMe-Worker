import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, parse, errorDetails } from '../scripts/story.mjs';
let folder: string, tokenFile: string;
const TOKEN = 'lm_' + 'a'.repeat(64);
const QWEN = '@cf/qwen/qwen3.8-27b';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const args = () => ['--base-url', 'http://localhost:8787', '--token-file', tokenFile, '--date', '2026-11-21', '--confirm-model-call'];
const successData = (extra = {}) => ({ date: '2026-11-21', story_count: 2, story_count_mode: 'auto', photo_count: 3, model: QWEN, story_version: 'v5', stories: [{ title: '故事1' }, { title: '故事2' }], request_id: 'test-id', ...extra });
const success = () => Response.json(successData());
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lookme-story-cli-')); tokenFile = path.join(folder, 'user.token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
});
afterEach(() => { fs.rmSync(folder, { recursive: true, force: true }); });
it('脚本帮助不读凭据、不请求网络', async () => {
  const fetch = vi.fn(); expect((await run(['--help'], fetch)).help).toContain('--confirm-model-call'); expect(fetch).not.toHaveBeenCalled();
});
it('必须显式确认模型调用并提供服务地址', async () => {
  const fetch = vi.fn(); await expect(run(args().slice(0, -1), fetch)).rejects.toThrow('confirm-model-call'); expect(fetch).not.toHaveBeenCalled();
});
it('Token仅进入请求头，不进入正文、URL和返回值', async () => {
  const fetch = vi.fn(async (_url, _options) => success());
  const result = await run(args(), fetch);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('http://localhost:8787/stories'); expect(options.redirect).toBe('error');
  expect(options.headers.Authorization).toBe('Bearer ' + TOKEN);
  expect(options.body).not.toContain(TOKEN); expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(JSON.parse(options.body)).toEqual({ date: '2026-11-21', model: QWEN, story_version: 'v5' });
  expect(JSON.parse(options.body)).not.toHaveProperty('story_count');
});
it('保存为0600的新文件；已有输出会在模型调用前拒绝', async () => {
  const out = path.join(folder, 'result.story.json'); const fetch = vi.fn(async () => success());
  expect(await run([...args(), '--out', out], fetch)).toMatchObject({ saved_file: out });
  expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(out, 'utf8')).stories).toHaveLength(2);
  await expect(run([...args(), '--out', out], fetch)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
});
it('拒绝不安全的Token/输出目录权限', async () => {
  const fetch = vi.fn(); fs.chmodSync(tokenFile, 0o644);
  await expect(run(args(), fetch)).rejects.toThrow('0600'); fs.chmodSync(tokenFile, 0o600);
  const open = path.join(folder, 'open'); fs.mkdirSync(open, { mode: 0o755 });
  await expect(run([...args(), '--out', path.join(open, 'result.json')], fetch)).rejects.toThrow('0700'); expect(fetch).not.toHaveBeenCalled();
});
it.each(['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'file:///tmp/file'])('拒绝非安全源地址：%s', url => {
  const input = args(); input[1] = url; expect(() => parse(input)).toThrow();
});
it.each(['0', '3', '9', 'auto'])('移除--stories，不接受遗留参数：%s', async n => {
  const fetch = vi.fn();
  await expect(run([...args(), '--stories', n], fetch)).rejects.toThrow('--stories 已移除');
  expect(fetch).not.toHaveBeenCalled();
});
it('错误日期、未知/重复参数在调用前拒绝', () => {
  const input = args(); input[5] = '2026-02-30'; expect(() => parse(input)).toThrow('日期');
  expect(() => parse([...args(), '--date', '2026-11-20'])).toThrow('重复');
  expect(() => parse([...args(), '--owner', 'someone'])).toThrow('未知');
});
it.each(['network', 'http', 'oversized', 'invalid', 'redirect'])('失败 %s 仅请求一次，不输出凭据或底层错误', async kind => {
  const fetch = vi.fn(async () => {
    if (kind === 'network' || kind === 'redirect') throw new Error(TOKEN + '底层敏感错误');
    if (kind === 'http') return Response.json({ error: 'model_timeout', model_call_attempted: true }, { status: 504 });
    if (kind === 'oversized') return new Response('x'.repeat(512 * 1024 + 1));
    return new Response('invalid');
  });
  await expect(run(args(), fetch)).rejects.toThrow(/不自动重试/); expect(fetch).toHaveBeenCalledOnce();
});
it('服务端拒绝且未调用模型时明确提示', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'summaries_not_ready', model_call_attempted: false }, { status: 409 }));
  await expect(run(args(), fetch)).rejects.toThrow('服务端报告未调用模型'); expect(fetch).toHaveBeenCalledOnce();
});

it('输出固定诊断字段与request_id，不回显服务器附带的敏感值', async () => {
  const id='e7fb03df-c723-4f96-b540-5ed1bdb48ae2';
  const fetch=vi.fn(async () => Response.json({ error:'invalid_story_result', model_call_attempted:true, validation_code:'unknown_source_id',
    validation_path:'$.stories[0].source_photo_ids', model_stage:'validating_output', request_id:id, secret:TOKEN }, {status:502}));
  await expect(run(args(),fetch)).rejects.toThrow('校验原因：unknown_source_id；字段：$.stories[0].source_photo_ids；阶段：validating_output；request_id='+id);
  expect(fetch).toHaveBeenCalledOnce();
  expect(errorDetails({validation_code:TOKEN,validation_path:TOKEN,request_id:TOKEN,model_stage:TOKEN})).toBe('');
});

it('保存结果时仍在终端返回覆盖信息，不能隐藏精选后的未引用清单', async () => {
  const out=path.join(folder,'representative.story.json');
  const coverage={policy:'representative_panels',input_photo_count:3,referenced_photo_count:2,all_photos_referenced:false,unreferenced_photo_ids:['local-photo-3']};
  const fetch=vi.fn(async()=>Response.json(successData({ coverage })));
  expect(await run([...args(),'--out',out],fetch)).toMatchObject({saved_file:out,coverage});
  expect(JSON.parse(fs.readFileSync(out,'utf8')).coverage).toEqual(coverage);
  expect(fetch).toHaveBeenCalledOnce();
});

it('离线列模型不读Token、不访问网络',async()=>{
  const fetch=vi.fn();const result=await run(['--list-models'],fetch);
  expect(result.models).toEqual([{model:QWEN,story_version:'v5',story_count_mode:'auto'},{model:GEMMA,story_version:'v5-gemma',story_count_mode:'auto'}]);
  expect(fetch).not.toHaveBeenCalled();
});
it('选择Gemma，无固定数量，保存实际模型与返回的数量',async()=>{
  const fetch=vi.fn(async()=>Response.json(successData({model:GEMMA,story_version:'v5-gemma',story_count:1,stories:[{}]})));
  const result=await run([...args(),'--model',GEMMA],fetch);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({date:'2026-11-21',model:GEMMA,story_version:'v5-gemma'});
  expect(result.story_count).toBe(1);expect(result.model).toBe(GEMMA);
});
it.each(['@cf/unknown/model','https://evil.example','__proto__'])('未知模型在请求前拒绝：%s',async model=>{
  const fetch=vi.fn();await expect(run([...args(),'--model',model],fetch)).rejects.toThrow('不支持该模型');expect(fetch).not.toHaveBeenCalled();
});
it('显式版本和模型必须一致，重复参数不接受',()=>{
  expect(()=>parse([...args(),'--model',GEMMA,'--story-version','v5'])).toThrow('不一致');
  expect(()=>parse([...args(),'--model',GEMMA,'--model',QWEN])).toThrow('重复');
  expect(parse([...args(),'--story-version','v4']).body).toEqual({date:'2026-11-21',model:QWEN,story_version:'v4'});
});
it.each([
  {story_count:0,stories:[]},{story_count:9,photo_count:10,stories:Array(9).fill({})},
  {story_count:1,stories:[{},{}]},{story_count:2,photo_count:1},
  {model:GEMMA},{story_version:'v4'},{story_count_mode:'fixed'},
])('拒绝模型或数量元数据与实际结果不符：%j',async extra=>{
  const fetch=vi.fn(async()=>Response.json(successData(extra)));
  await expect(run(args(),fetch)).rejects.toThrow('结果格式或模型版本异常');expect(fetch).toHaveBeenCalledOnce();
});
it.each([
 ['model_payment_required','付款问题'],['model_quota_exceeded','免费额度已耗尽'],['model_paid_plan_required','需要 Workers Paid'],['model_rate_limited','请求限制'],
])('命令行显示计费类错误的固定中文提示：%s',async(error,hint)=>{
 const fetch=vi.fn(async()=>Response.json({error,model:QWEN,request_duration_ms:100,model_call_attempted:true,message:TOKEN,usage:{},cost:{status:'unavailable',estimated_usd:null}},{status:402}));
 await expect(run(args(),fetch)).rejects.toThrow(hint);expect(fetch).toHaveBeenCalledOnce();
});
it('保存故事文件时终端摘要也保留模型、耗时、token和费用明细',async()=>{
 const out=path.join(folder,'accounted.story.json');
 const metrics={request_duration_ms:500,model_timings:{total_ms:400},usage:{prompt_tokens:100,completion_tokens:200},
 cost:{status:'estimated',is_estimate:true,estimated_usd:0.000685,currency:'USD',pricing:{input:0.45,output:3.2}}};
 const fetch=vi.fn(async()=>Response.json(successData(metrics)));
 const summary=await run([...args(),'--out',out],fetch);
 expect(summary).toMatchObject({...metrics,model:QWEN,client_request_ms:expect.any(Number)});
 expect(JSON.parse(fs.readFileSync(out,'utf8'))).toMatchObject({...metrics,client_request_ms:expect.any(Number)});
});
