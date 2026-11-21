#!/usr/bin/env python3
"""列出 LookMe 用户并为选定用户重新签发 Token。

签发、撤销仍交给 worker-upload/scripts/users.mjs：明文只进新建的 0600 文件，
D1 只写哈希。本脚本只补充只读的用户列表，以及签发前的 Wrangler 登录确认。

--remote 会真实改动开发环境数据库。登录走 `wrangler login`，需要在自动打开的
浏览器里手动完成授权；本脚本不保存、不转发任何管理凭据。
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'worker-cloudflare' / 'worker-upload'
WRANGLER = ROOT / 'node_modules' / 'wrangler' / 'bin' / 'wrangler.js'
IDENT = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
HELP = '''用法：python3 reissue_token.py list    [--remote]
      python3 reissue_token.py reissue --user 用户ID --out 新文件 [--days 90] [--remote]

默认操作本地数据库；--remote 固定指向 dev 环境并真实生效。
list 只读，显示用户、状态、未撤销与已撤销 Token 数量，不显示哈希或明文。
reissue 先确认 wrangler 登录（未登录则打开浏览器手动授权），签发后可选撤销旧 Token。
--out 必须是仓库外、尚不存在的文件，父目录属于当前用户且权限 0700。'''


def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def target(remote):
    return ['--env', 'dev', '--remote'] if remote else ['--config', 'wrangler.local.jsonc', '--local']


def query(remote, sql):
    """只读查询。远端走 --command 才能拿到结果行。"""
    output = subprocess.run(['node', str(WRANGLER), 'd1', 'execute', 'lookme-dev',
                             *target(remote), '--command', sql, '--json'],
                            cwd=ROOT, capture_output=True, text=True)
    if output.returncode != 0:
        tail = output.stderr.strip().splitlines()[-1] if output.stderr.strip() else '无详细输出'
        die('查询失败：' + tail)
    return json.loads(output.stdout)


def whoami():
    output = subprocess.run(['node', str(WRANGLER), 'whoami'], cwd=ROOT, capture_output=True, text=True)
    return output.stdout.strip() if output.returncode == 0 else ''


def ensure_login():
    if not WRANGLER.is_file():
        die('找不到 wrangler，先在 worker-cloudflare/worker-upload 执行 npm ci')
    identity = whoami()
    if identity:
        print('当前 Cloudflare 登录：\n' + identity)
        return
    print('尚未登录。将打开浏览器，请手动完成授权（wrangler login）。')
    if subprocess.run(['node', str(WRANGLER), 'login'], cwd=ROOT).returncode != 0 or not whoami():
        die('登录未完成，已中止，未做任何更改。')
    print('登录完成：\n' + whoami())


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M UTC') if ms else '-'


def rows_of(payload):
    return [row for item in payload for row in item.get('results', [])]


def list_users(remote):
    results = rows_of(query(remote, """SELECT u.user_id, u.status, u.created_at_ms,
        (SELECT count(*) FROM user_tokens t WHERE t.user_id = u.user_id AND t.revoked_at_ms IS NULL) AS live,
        (SELECT count(*) FROM user_tokens t WHERE t.user_id = u.user_id AND t.revoked_at_ms IS NOT NULL) AS revoked
        FROM users u ORDER BY u.created_at_ms"""))
    if not results:
        print('没有用户。')
        return
    print(f'{"用户 ID":<38}{"状态":<10}{"有效 Token":<12}{"已撤销":<8}创建时间')
    for row in results:
        print(f'{row["user_id"]:<38}{row["status"]:<10}{row["live"]:<12}{row["revoked"]:<8}{stamp(row["created_at_ms"])}')


def tokens_of(remote, user):
    return rows_of(query(remote, f"""SELECT token_id, created_at_ms, expires_at_ms, revoked_at_ms FROM user_tokens
        WHERE user_id = '{user}' ORDER BY created_at_ms"""))


def confirm(prompt):
    try:
        return input(prompt + ' [y/N] ').strip().lower() == 'y'
    except EOFError:
        return False


def reissue(remote, user, days, out):
    if not IDENT.fullmatch(user):
        die('用户 ID 必须是字母、数字、下划线或短横线')
    if not days.isdigit() or not 1 <= int(days) <= 365:
        die('--days 必须为 1–365')
    owned = tokens_of(remote, user)
    if not any(row['revoked_at_ms'] is None for row in owned):
        print('该用户当前没有未撤销的 Token。')
    else:
        print('该用户现有 Token：')
        for row in owned:
            state = '已撤销 ' + stamp(row['revoked_at_ms']) if row['revoked_at_ms'] else '有效至 ' + stamp(row['expires_at_ms'])
            print(f'  {row["token_id"]}  {state}')
    where = '开发环境' if remote else '本地'
    print(f'将在{where}为 {user} 签发 {days} 天的新 Token，写入 {out}')
    if not confirm('确认签发？'):
        die('已取消，未做任何更改。')
    scope = '--remote' if remote else '--local'
    if subprocess.run(['node', 'scripts/users.mjs', 'issue-token', scope,
                       '--user', user, '--days', days, '--out', out], cwd=ROOT).returncode != 0:
        die('签发未确认成功；若已生成文件，不要直接重试，先核对数据库。')
    old = [row['token_id'] for row in tokens_of(remote, user) if row['revoked_at_ms'] is None][:-1]
    if old and confirm(f'新 Token 已签发。撤销此前 {len(old)} 个未撤销的旧 Token？'):
        for token_id in old:
            subprocess.run(['node', 'scripts/users.mjs', 'revoke-token', scope, '--token-id', token_id], cwd=ROOT, check=False)
        print('旧 Token 撤销命令已执行，请核对上面每条的输出。')
    else:
        print('旧 Token 保持原状。')


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(HELP)
        return 0
    remote = '--remote' in args
    if remote:
        ensure_login()
    command, options = args[0], args[1:]
    if command == 'list':
        if any(item != '--remote' for item in options):
            die('list 只接受 --remote')
        list_users(remote)
    elif command == 'reissue':
        user = out = None
        days, index = '90', 0
        while index < len(options):
            item = options[index]
            if item == '--remote':
                index += 1
                continue
            if item in ('--user', '--out', '--days') and index + 1 < len(options):
                index += 1
                if item == '--user':
                    user = options[index]
                elif item == '--out':
                    out = options[index]
                else:
                    days = options[index]
            else:
                die('未知参数：' + item)
            index += 1
        if not user or not out:
            die('reissue 需要 --user 与 --out')
        reissue(remote, user, days, out)
    else:
        die('未知命令：' + command + '（可用 list、reissue）')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        die('已中断。')
