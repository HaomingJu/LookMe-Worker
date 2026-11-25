// 受控管理员工具：仅向 D1 写入 Token 哈希，明文仅写入新建的受限文件。
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
    else if (['--user', '--token-id', '--out', '--days'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error(`不支持的参数：${key}`);
  }
  if (Boolean(options['--local']) === Boolean(options['--remote'])) throw new Error('必须显式选择 --local 或 --remote（远端目标仅为 dev）');
  return options;
}
function identifier(value) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value ?? '')) throw new Error('用户/凭据 ID 必须是不透明的字母、数字、下划线或短横线标识');
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
export function makeCredential() {
  const token = `lm_${randomBytes(32).toString('hex')}`;
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
export function main(args) {
  const [command, ...rest] = args;
  if (!['create-user', 'issue-token', 'revoke-token', 'disable-user', 'enable-user'].includes(command)) throw new Error('用法：users.mjs create-user|issue-token|revoke-token|disable-user|enable-user --local|--remote [--user ID] [--token-id ID] [--out 文件] [--days 天数]');
  const options = parse(rest);
  const now = Date.now();
  if (command === 'create-user') {
    const id = randomUUID();
    execute(`INSERT INTO users (user_id, created_at_ms) VALUES ('${id}', ${now});`, options);
    console.log(`用户已创建：${id}`);
  } else if (command === 'issue-token') {
    const user = identifier(options['--user']);
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
        SELECT '${id}', user_id, '${hash}', ${now}, ${expires} FROM users WHERE user_id = '${user}' AND status = 'active' RETURNING token_id;`, options);
      if (rows.length !== 1) throw new Error('用户不存在或已停用');
    } catch (error) { throw new Error(`${error.message}；本地文件已保留但本次签发未确认成功：${out}`); }
    console.log(`凭据已签发：${id}；到期：${new Date(expires).toISOString()}；秘密文件：${out}（不输出 Token）`);
  } else {
    const id = identifier(options[command === 'revoke-token' ? '--token-id' : '--user']);
    const sql = command === 'revoke-token'
      ? `UPDATE user_tokens SET revoked_at_ms = COALESCE(revoked_at_ms, ${now}) WHERE token_id = '${id}' RETURNING token_id;`
      : `UPDATE users SET status = '${command === 'disable-user' ? 'disabled' : 'active'}' WHERE user_id = '${id}' RETURNING user_id;`;
    if (execute(sql, options).length !== 1) throw new Error('目标用户或凭据不存在');
    console.log(`${command} 已完成：${id}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
