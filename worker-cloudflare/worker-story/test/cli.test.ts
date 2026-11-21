import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, parse } from '../scripts/story.mjs';
let folder: string, tokenFile: string;
const TOKEN = 'lm_' + 'a'.repeat(64);
const args = () => ['--base-url', 'http://localhost:8787', '--token-file', tokenFile, '--date', '2026-11-21', '--stories', '2', '--confirm-model-call'];
const success = () => Response.json({ date: '2026-11-21', story_count: 2, stories: [{ title: '故事1' }, { title: '故事2' }], request_id: 'test-id' });
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
  expect(JSON.parse(options.body)).toEqual({ date: '2026-11-21', story_count: 2, story_version: 'v1' });
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
it.each(['0', '9', '1.5', '2x'])('拒绝非法N：%s', n => {
  const input = args(); input[7] = n; expect(() => parse(input)).toThrow();
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
