import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { execute, statements } = vi.hoisted(() => ({ execute: vi.fn(), statements: [] as string[] }));
vi.mock('node:child_process', () => ({ execFileSync: execute }));
import { main, makeCredential } from '../scripts/users.mjs';
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lookme-cli-test-'));
  statements.length = 0;
  execute.mockReset();
  execute.mockImplementation((_exe: string, args: string[]) => {
    statements.push(args.includes('--command') ? args[args.indexOf('--command') + 1] : readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
    return Buffer.from(JSON.stringify([{ results: [{ token_id: 'test-result' }] }]));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { rmSync(folder, { recursive: true, force: true }); vi.restoreAllMocks(); });
it('随机凭据有 256 位熵；哈希与明文一致且每次不同', () => {
  const a = makeCredential();
  const b = makeCredential();
  expect(a.token).toMatch(/^lm_[0-9a-f]{64}$/);
  expect(a.token).not.toBe(b.token);
  expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'));
});
it('签发仅写哈希，明文存 0600 文件且不打印', () => {
  const out = join(folder, 'token');
  main(['issue-token', '--local', '--user', 'test-owner', '--out', out]);
  const token = readFileSync(out, 'utf8').trim();
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(statements[0]).toContain(createHash('sha256').update(token).digest('hex'));
  expect(statements[0]).not.toContain(token);
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(token);
  const args = execute.mock.calls[0][1];
  expect(args).toContain('--local');
  expect(args).not.toContain('--remote');
});
it('拒绝未指定目标、注入 ID、已有输出文件及仓库内秘密文件', () => {
  expect(() => main(['create-user'])).toThrow('显式选择');
  expect(() => main(['disable-user', '--local', '--user', "x';DELETE"])).toThrow('标识');
  const out = join(folder, 'token');
  main(['issue-token', '--local', '--user', 'test-owner', '--out', out]);
  expect(() => main(['issue-token', '--local', '--user', 'test-owner', '--out', out])).toThrow('尚不存在');
  expect(() => main(['issue-token', '--local', '--user', 'test-owner', '--out', './token-secret'])).toThrow('仓库外');
});
it('远端操作显式 dev，不输出管理操作底层错误', () => {
  main(['disable-user', '--remote', '--user', 'test-owner']);
  expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['--env', 'dev', '--remote', '--command']));
  execute.mockImplementation(() => { throw new Error('sensitive details'); });
  expect(() => main(['enable-user', '--local', '--user', 'test-owner'])).toThrow('D1 操作失败');
});
it('签发失败保留受限文件并明确未确认成功', () => {
  execute.mockReturnValue(Buffer.from('[{"results":[]}]'));
  const out = join(folder, 'token');
  expect(() => main(['issue-token', '--local', '--user', 'missing', '--out', out])).toThrow('未确认成功');
  expect(statSync(out).mode & 0o777).toBe(0o600);
});
