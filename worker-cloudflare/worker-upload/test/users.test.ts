import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { execute, statements, sqlOf } = vi.hoisted(() => {
  const execute = vi.fn();
  const statements: string[] = [];
  const sqlOf = (args: string[]) => (args.includes('--command') ? args[args.indexOf('--command') + 1] : readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
  return { execute, statements, sqlOf };
});
vi.mock('node:child_process', () => ({ execFileSync: execute }));
import { main, makeCredential } from '../scripts/users.mjs';

const json = (rows: Record<string, unknown>[]) => Buffer.from(JSON.stringify([{ results: rows }]));
const user = (user_id: string) => ({ user_id, username: null, status: 'active', created_at_ms: 1, token_count: 0 });

let folder: string;
let responses: Record<string, unknown>[][] = [];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lookme-cli-test-'));
  statements.length = 0;
  responses = [];
  execute.mockReset();
  execute.mockImplementation((_exe: string, args: string[]) => {
    statements.push(sqlOf(args));
    return json(responses.length ? responses.shift()! : []);
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

it('create-user 要求用户名并写入唯一用户名', () => {
  responses = [[], [{ user_id: 'u1' }]];
  main(['create-user', '--local', '--username', 'alice']);
  expect(statements[0]).toContain("username = 'alice' COLLATE NOCASE");
  expect(statements[1]).toContain('INSERT INTO users (user_id, username, created_at_ms)');
  expect(statements[1]).toMatch(/VALUES \('[0-9a-f-]{36}', 'alice', \d+\)/);
});

it('create-user 校验用户名格式并拒绝重复', () => {
  expect(() => main(['create-user', '--local', '--username', 'bad name'])).toThrow('用户名必须');
  expect(() => main(['create-user', '--local', '--username', "x';DELETE"])).toThrow('用户名必须');
  responses = [[{ user_id: 'other' }]];
  expect(() => main(['create-user', '--local', '--username', 'alice'])).toThrow('创建失败：用户名已存在');
});

it('list-users 能查询用户名', () => {
  responses = [[{ ...user('u1'), username: 'alice', token_count: 2 }]];
  main(['list-users', '--local']);
  expect(statements[0]).toContain('FROM users ORDER BY');
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain('alice');
});

it('show-user 以用户名定位并查询详情', () => {
  responses = [[{ user_id: 'u1' }], [{ ...user('u1'), username: 'alice' }]];
  main(['show-user', '--local', '--user', 'alice']);
  expect(statements[0]).toContain("username = 'alice' COLLATE NOCASE");
  expect(statements[1]).toContain("FROM users WHERE user_id = 'u1'");
});

it('list-tokens 列出某用户名下的 token 及状态', () => {
  const now = Date.now();
  responses = [[{ user_id: 'u1' }], [
    { token_id: 't-active', created_at_ms: now, expires_at_ms: now + 86400000, revoked_at_ms: null },
    { token_id: 't-revoked', created_at_ms: now, expires_at_ms: now + 86400000, revoked_at_ms: now },
    { token_id: 't-expired', created_at_ms: now, expires_at_ms: now - 1, revoked_at_ms: null },
  ]];
  main(['list-tokens', '--local', '--user', 'alice']);
  expect(statements[0]).toContain("username = 'alice' COLLATE NOCASE");
  expect(statements[1]).toContain("FROM user_tokens WHERE user_id = 'u1'");
  const logged = JSON.stringify(vi.mocked(console.log).mock.calls);
  expect(logged).toContain('t-active');
  expect(logged).toContain('有效');
  expect(logged).toContain('已撤销');
  expect(logged).toContain('已过期');
});

it('rename-user 先解析用户再改用户名，拒绝占用', () => {
  responses = [[{ user_id: 'u1' }], [], [{ username: 'bob' }]];
  main(['rename-user', '--local', '--user', 'alice', '--username', 'bob']);
  expect(statements[0]).toContain("username = 'alice' COLLATE NOCASE");
  expect(statements[1]).toContain("username = 'bob' COLLATE NOCASE");
  expect(statements[2]).toContain("SET username = 'bob' WHERE user_id = 'u1'");

  statements.length = 0;
  responses = [[{ user_id: 'u1' }], [{ user_id: 'other' }]];
  expect(() => main(['rename-user', '--local', '--user', 'u1', '--username', 'bob'])).toThrow('已被占用');
});

it('delete-user 有引用时拒绝', () => {
  responses = [[{ user_id: 'u1' }], [{ refs: 3 }]];
  expect(() => main(['delete-user', '--local', '--user', 'u1'])).toThrow('拒绝删除');
});

it('delete-user 无引用时才删除', () => {
  responses = [[{ user_id: 'u1' }], [{ refs: 0 }], [{ user_id: 'u1' }]];
  main(['delete-user', '--local', '--user', 'alice']);
  expect(statements[0]).toContain("username = 'alice' COLLATE NOCASE");
  expect(statements[1]).toContain('AS refs');
  expect(statements[2]).toContain("DELETE FROM users WHERE user_id = 'u1'");
});

it('签发仅写哈希，明文存 0600 文件且不打印，可凭用户名定位', () => {
  const out = join(folder, 'token');
  responses = [[{ user_id: 'test-owner' }], [{ token_id: 'test-result' }]];
  main(['issue-token', '--local', '--user', 'alice', '--out', out]);
  const token = readFileSync(out, 'utf8').trim();
  expect(statSync(out).mode & 0o777).toBe(0o600);
  const insert = statements[1];
  expect(insert).toContain(createHash('sha256').update(token).digest('hex'));
  expect(insert).not.toContain(token);
  expect(insert).toContain("WHERE user_id = 'test-owner' AND status = 'active'");
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(token);
  const args = execute.mock.calls[0][1];
  expect(args).toContain('--local');
  expect(args).not.toContain('--remote');
});

it('允许用户指定的非0700目录，只拒绝组/其他用户可写目录', () => {
  chmodSync(folder, 0o750);
  const out = join(folder, 'user-specified.token');
  responses = [[{ user_id: 'test-owner' }], [{ token_id: 'test-result' }]];
  main(['issue-token', '--local', '--user', 'test-owner', '--out', out]);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  chmodSync(folder, 0o700);
});

it('拒绝未指定目标、注入 ID、已有输出文件及仓库内秘密文件', () => {
  expect(() => main(['create-user'])).toThrow('显式选择');
  expect(() => main(['disable-user', '--local', '--user', "x';DELETE"])).toThrow('标识');

  const out = join(folder, 'token');
  responses = [[{ user_id: 'test-owner' }], [{ token_id: 'test-result' }]];
  main(['issue-token', '--local', '--user', 'test-owner', '--out', out]);

  statements.length = 0;
  responses = [[{ user_id: 'test-owner' }]];
  expect(() => main(['issue-token', '--local', '--user', 'test-owner', '--out', out])).toThrow('尚不存在');

  responses = [[{ user_id: 'test-owner' }]];
  expect(() => main(['issue-token', '--local', '--user', 'test-owner', '--out', './token-secret'])).toThrow('仓库外');

  chmodSync(folder, 0o777);
  responses = [[{ user_id: 'test-owner' }]];
  expect(() => main(['issue-token', '--local', '--user', 'test-owner', '--out', join(folder, 'writable.token')])).toThrow('不能允许');
  chmodSync(folder, 0o700);
});

it('远端操作显式 dev，不输出管理操作底层错误', () => {
  responses = [[{ user_id: 'test-owner' }], [{ user_id: 'test-owner' }]];
  main(['disable-user', '--remote', '--user', 'alice']);
  expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['--env', 'dev', '--remote', '--command']));
  execute.mockImplementation(() => { throw new Error('sensitive details'); });
  expect(() => main(['enable-user', '--local', '--user', 'alice'])).toThrow('D1 操作失败');
});

it('签发失败保留受限文件并明确未确认成功', () => {
  responses = [[{ user_id: 'test-owner' }], []];
  const out = join(folder, 'token');
  expect(() => main(['issue-token', '--local', '--user', 'missing', '--out', out])).toThrow('未确认成功');
  expect(statSync(out).mode & 0o777).toBe(0o600);
});
