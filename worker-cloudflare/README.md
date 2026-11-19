# LookMe 图片上传 Worker

`POST /photos` 将 JPEG 字节写入私有 R2 `PHOTOS`，元数据写入 D1 `DB`。每个用户使用独立随机 Bearer Token；D1 仅保存 SHA-256 哈希，不保存明文。任务生成、下载、CORS、速率限制和孤儿对象清理尚未实现。

## 本地运行

需要与锁定 Wrangler 兼容的 Node.js/npm。

```bash
npm ci
npm run db:migrate:local
npm run typecheck
npm test
npm run build
```

无需 `.dev.vars` 或共享 `UPLOAD_TOKEN`。应用 `0002_user_tokens.sql` 后创建本地用户，并为其签发凭据。使用你选择的仓库外秘密目录，权限必须为 0700；将命令返回的用户 ID 填入下一条命令。

```bash
mkdir -m 700 "$HOME/.lookme-credentials"
npm run users -- create-user --local
npm run users -- issue-token --local --user USER_ID --out "$HOME/.lookme-credentials/local-user.token"
npm run dev
```

目录已存在时先检查权限，不盲目覆盖。Token 文件必须尚不存在，文件权限为 0600；工具不会打印明文。用户从受限文件读取凭据并安全分发给该用户，不能把文件提交、粘贴到聊天或记录日志。

## 多用户鉴权

- 用户：`users.user_id` 是服务端生成的不透明 UUID；`status` 为 `active` / `disabled`。
- 凭据：32 字节加密随机数，格式 `lm_` 加 64 个十六进制字符；一个用户可有多个 Token。
- `user_tokens` 保存 token_id、user_id、token_hash、创建/过期/撤销时间。默认有效期 90 天；签发时 `--days 1–365`。
- 每次请求从哈希查询有效凭据及 active 用户；未知、撤销、过期或用户停用统一返回 `401`，不泄露具体原因。认证发生在读取上传正文之前；停用/撤销作用于后续鉴权，不保证取消已经通过鉴权的在途上传。
- owner 只来自认证结果。不同用户可使用同一个 client_photo_id，各自生成独立记录和 R2 对象。客户端提交 owner_id 等未知字段会被拒绝。
- 没有公开注册/签发/管理 API。管理 CLI 使用开发机/CI 的 Cloudflare 管理身份，不向用户提供该身份。
- 用户表/凭据表缺失或 D1 不可用时返回 `503`，不回退到旧共享 Token。旧 `UPLOAD_TOKEN` / `UPLOAD_OWNER_ID` 不再使用，也不自动转成新凭据。

管理命令必须显式指定 `--local` 或 `--remote`；远端固定为配置的 `dev` 环境：

```bash
npm run users -- create-user --local
npm run users -- issue-token --local --user USER_ID --days 30 --out /受限目录/new.token
npm run users -- revoke-token --local --token-id TOKEN_ID
npm run users -- disable-user --local --user USER_ID
npm run users -- enable-user --local --user USER_ID
```

轮换时先签发同用户的新 Token、验证后撤销旧 token_id，不更改照片归属。停用用户会阻止该用户所有 Token；重新启用后未撤销且未过期的 Token 恢复有效。撤销没有恢复命令。

CLI 校验管理标识，仅写 Token 哈希；本地使用受限临时 SQL 文件，远端使用 --command 获取实际查询结果，不传递 Token 明文。签发先保存明文再注册哈希；若 D1 失败，文件保留且报告未确认成功，不盲目重试。管理员应先检查目标数据库：网络错误不证明远端没有写成功。

## 请求与响应

使用 `multipart/form-data`：

| 字段 | 限制 |
| --- | --- |
| `file` | 恰好一张 JPEG，非空、≤ 2 MiB，每条边 ≤ 2048 px，真实解码校验 |
| `client_photo_id` | 稳定 UUID；重试相同照片时复用 |
| `source` | `cli`、`apple_app`、`device` |
| `captured_at` | 可选 RFC 3339，必须含时区，最多毫秒精度 |
| `captured_at_source` | 与拍摄时间成对；`exif`、`apple_photos`、`device`、`manual` |

请求总量上限 3 MiB，限制实际流式读取量。拒绝未知/重复字段。上传副本应事先旋转、转 sRGB 并移除 GPS；服务端验证但不重编码或清除 EXIF。

可用下列 Python 标准库示例发送请求，Token 从受限文件读取，不进入命令参数。将 USER_ID 替换为用户 ID，并保持同次重试的 JPEG、UUID 和元数据一致：

```python
from pathlib import Path
from urllib.request import Request, urlopen
import uuid

token = (Path.home() / '.lookme-credentials/local-user.token').read_text().strip()
boundary = uuid.uuid4().hex
client_id = str(uuid.uuid4())  # 重试时复用，不要重新生成。
parts = []
for name, value in [('client_photo_id', client_id), ('source', 'cli')]:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + Path('test.jpg').read_bytes() + b'\r\n')
parts.append(f'--{boundary}--\r\n'.encode())
request = Request('http://localhost:8787/photos', data=b''.join(parts), headers={
    'Authorization': f'Bearer {token}', 'Content-Type': f'multipart/form-data; boundary={boundary}'})
with urlopen(request) as response:
    print(response.status, response.read().decode())
```

首次 `201`：`{"photo_id":"服务端UUID","uploaded_at":"UTC时间"}`，可选 UTC `captured_at`，不返回对象键。相同 UUID/字节/元数据重传 `200`，不同内容/关键元数据 `409`。身份 `401`，字段 `400`，超限 `413`，格式 `415`，存储不可用 `503`。未知路径 `404`，`/photos` 非 POST 方法 `405`。

先写 R2 再插入 D1；并发通过唯一键收敛。失败可能留下未引用对象，不自动删除，不承诺 D1/R2 跨服务事务。

## 部署与历史数据

完整流程见 [部署 Skill](../skills/deploy_worker/SKILL.md)。应用新版代码前必须迁移 `0002_user_tokens.sql`。该迁移保留照片/任务的已有 owner，补建对应用户，但不会自动给他们签发 Token，也不重建业务表。现有 photos/comic_jobs 的 owner 字段暂未增加 users 外键，避免破坏性重建；新上传只接受认证得到的已有用户。

用户授权远端操作后：

```bash
npx wrangler d1 migrations list lookme-dev --env dev --remote
npx wrangler d1 migrations apply lookme-dev --env dev --remote
npm run users -- create-user --remote
npm run users -- issue-token --remote --user USER_ID --out /受限目录/dev-user.token
npm run deploy:dev
```

不要在未授权时执行以上远端命令。用户凭据不再通过 Worker Secret 注入；若远端仍有旧 UPLOAD_TOKEN，代码会忽略它，撤销/删除另行确认。不同环境独立签发 Token；换账号不复制凭据表或秘密。

`npm run build` 仅打包，不部署。纯 JS JPEG 解码可能触及套餐 CPU 上限，本地通过不保证所有大图在免费套餐可用；不自动升级套餐。
