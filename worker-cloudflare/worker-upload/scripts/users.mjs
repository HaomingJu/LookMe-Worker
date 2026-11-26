// 受控管理员工具：仅向 D1 写入 Token 哈希，明文仅写入新建的受限文件。
// 提供用户的增删改查：create-user / list-users / show-user / rename-user / delete-user，
// 以及凭据签发与用户启停：issue-token / revoke-token / disable-user / enable-user。
// user_id 仍为服务端 UUID 主键，username 为人类可记的唯一用户名，二者 1:1。
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(options, key)) throw new Error(`重复参数：${key}`);
    if (['--local', '--remote'].includes(key)) options[key] = true;
    else if (['--user', '--username', '--token-id', '--out', '--days'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error(`不支持的参数：${key}`);
  }
  if (Boolean(options['--local']) === Boolean(options['--remote'])) throw new Error('必须显式选择 --local 或 --remote（远端目标仅为 dev）');
  return options;
}
function identifier(value) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value ?? '')) throw new Error('用户/凭据 ID 必须是不透明的字母、数字、下划线或短横线标识');
  return value;
}
function username(value) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value ?? '')) throw new Error('用户名必须是 1–64 位字母、数字、下划线或短横线');
  return value;
}
function execute(sql, options) {
  const temp = mkdtempSync(resolve(tmpdir(), 'lookme-admin-'));
  try {
    const file = resolve(temp, 'operation.sql');
    writeFileSync(file, sql, { mode: 0o600 });
    const target = options['--remote'] ? ['--env', 'dev', '--remote'] : ['--config', 'wrangler.local.jsonc', '--local'];
    // 远端 --file 走导入 API，不返回 RETURNING 行；--command 只包含 ID/哈希，绝不包含 Token 明文。
    const input = options['--remote'] ? ['--command', sql] : ['--file', file];
    const output = execFileSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'lookme-dev', ...target, ...input, '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output.toString()).flatMap(item => item.results ?? []);
  } catch {
    throw new Error('D1 操作失败；检查登录身份、目标 dev 配置及迁移。未输出底层 SQL/凭据。');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
// 把 --user（用户名或 user_id）解析为唯一 user_id；先校验再查询，避免歧义时误改多行。
function resolveUserId(value, options) {
  const id = identifier(value);
  const rows = execute(`SELECT user_id FROM users WHERE user_id = '${id}' OR username = '${id}' COLLATE NOCASE;`, options);
  if (rows.length !== 1) throw new Error('目标用户不存在或标识不唯一');
  return rows[0].user_id;
}
export function makeCredential() {
  const token = `lm_${randomBytes(32).toString('hex')}`;
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
export function main(args) {
  const commands = ['create-user', 'list-users', 'show-user', 'list-tokens', 'rename-user', 'delete-user', 'issue-token', 'revoke-token', 'disable-user', 'enable-user'];
  const [command, ...rest] = args;
  if (!commands.includes(command)) throw new Error('用法：users.mjs create-user|list-users|show-user|list-tokens|rename-user|delete-user|issue-token|revoke-token|disable-user|enable-user --local|--remote [--user 用户名或ID] [--username 用户名] [--token-id ID] [--out 文件] [--days 天数]');
  const options = parse(rest);
  const now = Date.now();

  if (command === 'create-user') {
    const name = username(options['--username']);
    const id = randomUUID();
    if (execute(`SELECT user_id FROM users WHERE username = '${name}' COLLATE NOCASE;`, options).length !== 0) throw new Error('创建失败：用户名已存在');
    execute(`INSERT INTO users (user_id, username, created_at_ms) VALUES ('${id}', '${name}', ${now});`, options);
    console.log(`用户已创建：${name}（user_id：${id}）`);
    return;
  }
  if (command === 'list-users') {
    const rows = execute(`SELECT user_id, username, status, created_at_ms,
      (SELECT COUNT(*) FROM user_tokens t WHERE t.user_id = users.user_id) AS token_count
      FROM users ORDER BY created_at_ms, user_id;`, options);
    console.log('user_id\tusername\tstatus\ttoken_count\tcreated_at');
    for (const r of rows) console.log(`${r.user_id}\t${r.username ?? '(未命名)'}\t${r.status}\t${r.token_count}\t${new Date(Number(r.created_at_ms)).toISOString()}`);
    return;
  }
  if (command === 'revoke-token') {
    const id = identifier(options['--token-id']);
    const rows = execute(`UPDATE user_tokens SET revoked_at_ms = COALESCE(revoked_at_ms, ${now}) WHERE token_id = '${id}' RETURNING token_id;`, options);
    if (rows.length !== 1) throw new Error('目标凭据不存在');
    console.log(`revoke-token 已完成：${id}`);
    return;
  }
  if (command === 'issue-token') {
    const userId = resolveUserId(options['--user'], options);
    const days = Number(options['--days'] ?? 90);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days 必须为 1–365 的整数，默认 90 天');
    if (!options['--out']) throw new Error('必须通过 --out 指定仓库外的新文件，父目录必须已存在且归当前用户所有');
    const out = resolve(realpathSync(dirname(resolve(options['--out']))), resolve(options['--out']).split(sep).at(-1));
    if (out === repo || out.startsWith(repo + sep) || existsSync(out)) throw new Error('Token 输出必须是仓库外尚不存在的文件');
    const parent = statSync(dirname(out));
    if ((parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid())) throw new Error('Token 文件的父目录必须属于当前用户且不能允许组/其他用户写入');
    const id = randomUUID();
    const { token, hash } = makeCredential();
    // 先安全保存凭据，后注册哈希；注册失败时保留文件，不会出现已激活却丢失 Token。
    writeFileSync(out, token + '\n', { flag: 'wx', mode: 0o600 });
    const expires = now + days * 86400000;
    try {
      const rows = execute(`INSERT INTO user_tokens (token_id, user_id, token_hash, created_at_ms, expires_at_ms)
        SELECT '${id}', user_id, '${hash}', ${now}, ${expires} FROM users WHERE user_id = '${userId}' AND status = 'active' RETURNING token_id;`, options);
      if (rows.length !== 1) throw new Error('用户已停用');
    } catch (error) { throw new Error(`${error.message}；本地文件已保留但本次签发未确认成功：${out}`); }
    console.log(`凭据已签发：${id}；到期：${new Date(expires).toISOString()}；秘密文件：${out}（不输出 Token）`);
    return;
  }

  const userId = resolveUserId(options['--user'], options);
  if (command === 'list-tokens') {
    const rows = execute(`SELECT token_id, created_at_ms, expires_at_ms, revoked_at_ms FROM user_tokens WHERE user_id = '${userId}' ORDER BY created_at_ms, token_id;`, options);
    console.log('token_id\tstate\tcreated_at\texpires_at\trevoked_at');
    for (const r of rows) {
      const revoked = r.revoked_at_ms != null;
      const expired = !revoked && Number(r.expires_at_ms) <= now;
      const state = revoked ? '已撤销' : expired ? '已过期' : '有效';
      console.log(`${r.token_id}\t${state}\t${new Date(Number(r.created_at_ms)).toISOString()}\t${new Date(Number(r.expires_at_ms)).toISOString()}\t${revoked ? new Date(Number(r.revoked_at_ms)).toISOString() : ''}`);
    }
    if (!rows.length) console.log('（无 token）');
    return;
  }
  if (command === 'show-user') {
    const rows = execute(`SELECT user_id, username, status, created_at_ms,
      (SELECT COUNT(*) FROM user_tokens t WHERE t.user_id = users.user_id) AS token_count
      FROM users WHERE user_id = '${userId}';`, options);
    const r = rows[0];
    console.log(`用户名：${r.username ?? '(未命名)'}\nuser_id：${r.user_id}\n状态：${r.status}\nToken 数：${r.token_count}\n创建时间：${new Date(Number(r.created_at_ms)).toISOString()}`);
    return;
  }
  if (command === 'rename-user') {
    const name = username(options['--username']);
    const clash = execute(`SELECT user_id FROM users WHERE username = '${name}' COLLATE NOCASE AND user_id <> '${userId}';`, options);
    if (clash.length !== 0) throw new Error(`用户名已被占用：${name}`);
    const rows = execute(`UPDATE users SET username = '${name}' WHERE user_id = '${userId}' RETURNING username;`, options);
    if (rows.length !== 1) throw new Error('更新失败：目标用户不存在');
    console.log(`用户名已更新：${userId} → ${name}`);
    return;
  }
  if (command === 'delete-user') {
    const refs = execute(`SELECT
      (SELECT COUNT(*) FROM user_tokens WHERE user_id = '${userId}') +
      (SELECT COUNT(*) FROM photos WHERE owner_id = '${userId}') +
      (SELECT COUNT(*) FROM comic_jobs WHERE owner_id = '${userId}') +
      (SELECT COUNT(*) FROM stories WHERE owner_id = '${userId}') +
      (SELECT COUNT(*) FROM story_runs WHERE owner_id = '${userId}') +
      (SELECT COUNT(*) FROM comic_runs WHERE owner_id = '${userId}') AS refs;`, options);
    if (Number(refs[0].refs) !== 0) throw new Error('该用户仍有关联令牌、照片、故事或漫画记录，拒绝删除');
    const rows = execute(`DELETE FROM users WHERE user_id = '${userId}' RETURNING user_id;`, options);
    if (rows.length !== 1) throw new Error('删除失败：目标用户不存在');
    console.log(`用户已删除：${userId}`);
    return;
  }
  const status = command === 'disable-user' ? 'disabled' : 'active';
  const rows = execute(`UPDATE users SET status = '${status}' WHERE user_id = '${userId}' RETURNING user_id;`, options);
  if (rows.length !== 1) throw new Error('目标用户不存在');
  console.log(`${command} 已完成：${userId}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
