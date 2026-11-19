# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目现状与架构

LookMe 的目标是照片上传后异步生成四格漫画。**当前只实现 Cloudflare 图片上传与独立用户 Token 鉴权**；`worker-generate-image/` 为空，队列消费者、模型调用、建单、查询和下载 API 均尚未实现。`TODOs.md` 是规划清单，不是当前实现或远端操作授权的依据。

唯一应用项目位于 `worker-cloudflare/`，没有仓库根目录 npm workspace。运行入口为 `src/index.ts`，使用 Cloudflare 原生 Request/Response、D1/R2 bindings 和 `jpeg-js`，没有路由框架。

上传路径：`POST /photos` → 在 D1 查验 Token 哈希、有效期、撤销状态及 active 用户 → 有界读取 multipart → JPEG 文件/尺寸/实际解码验证 → SHA-256 → 按认证 owner 和客户端 UUID 查幂等记录 → 写私有 R2 → 插入 D1 → 返回 photo_id 和时间。

- 运行时使用 `DB`、`PHOTOS`；配置中的 `COMICS` 桶目前未被上传代码使用。
- 用户 owner 只能来自认证查询，不来自请求正文。不同用户的客户端 UUID 独立；同用户同 UUID、不同字节或关键元数据返回 `409`。
- R2 与 D1 无跨服务事务。并发由 `UNIQUE(owner_id, client_photo_id)` 收敛；D1 失败或并发竞争可能留下孤儿 R2 对象，代码不会盲删。
- JPEG 上限 2 MiB、每边 2048 px，请求总量 3 MiB；先检查 SOF 尺寸再完整解码。服务端不重编码、旋转或清除 EXIF。
- 用户 Token 不是 Cloudflare 管理凭据：`lm_` + 64 个小写十六进制字符（32 随机字节），D1 仅存 SHA-256。旧 `UPLOAD_TOKEN` / `UPLOAD_OWNER_ID` 不再使用。

## 开发命令

以下命令均从 `worker-cloudflare/` 执行：

```bash
npm ci
npm run db:migrate:local  # 仅迁移本地 Wrangler D1
npm run dev               # 使用 wrangler.local.jsonc；通常监听 localhost:8787
npm run typecheck         # tsc --noEmit；仅覆盖 src/**/*.ts
npm test                  # Vitest 全部测试，不连接远端
npm run test:clients      # 五语言本地协议测试；需要 CMake、libcurl、C/C++、curl 和 Python 3
npm run test:batch        # C++ 批量上传的8并发、连接复用及恢复协议测试
npm run test:batch:all    # C/C++/JS/Python/curl 独立批量实现回归
npm test -- test/upload.test.ts
npm test -- test/upload.test.ts -t "不同用户"
npm test -- test/users.test.ts -t "签发仅写哈希"
npm run build             # wrangler deploy --env dev --dry-run，不上线
```

当前没有独立 lint/formatter 命令。依赖精确版本和 `package-lock.json` 是复现依据，不全局安装或随意升级 Wrangler。

### 测试运行方式

`test/upload.test.ts` 用 esbuild 将入口打包给 Miniflare，按文件名顺序应用所有 SQL 迁移，使用临时真实 D1/R2 验证上传；存储故障用 mock 验证。Miniflare 5 使用官方 `convertV4MiniflareOptions` 转换配置。Node 原生 FormData 先通过 Request 序列化为字节/headers，再交给 Miniflare，避免两套 FormData 实现不兼容。

`test/users.test.ts` 测试管理员 CLI 的随机凭据、输出权限、参数验证及失败行为，mock 子进程以避免远端管理操作。测试硬编码 Token 是本地测试夹具，不是部署凭据。

`test/clients/` 是五语言可执行上传客户端及本地协议回归工具。C/C++ 的 CMake 构建、临时 mock 服务和 40 项上传协议及参数/帮助检查由 `verify.py` 管理；这是传输测试，不取代上述 D1/R2 集成测试，也不自动运行远端测试。

`upload_batch_cpp` 是独立批量客户端，不修改 Worker API；libcurl multi 最多8并发，首次自动在用户主目录创建受限批次文件并输出 STATE_FILE，保存每张UUID和完成状态；失败时用 --state 恢复原文件，而非生成新UUID。用 `verify_batch.py` 本地验证并发/连接复用、失败及中断恢复；具体命令见 `test/clients/BATCH.md`。C有独立libcurl multi实现，JS用undici连接池，Python用持久连接线程池，curl用parallel进程；脚本不包装C++。Python/JS/curl共享JSON状态格式，C和C++各自格式不同。

## 本地身份与管理工具

应用本地迁移后，通过 `scripts/users.mjs` 创建用户并签发 Token，开发服务器无需共享 Secret：

```bash
npm run users -- create-user --local
npm run users -- issue-token --local --user USER_ID --out /已存在的受限目录/new.token
npm run users -- revoke-token --local --token-id TOKEN_ID
npm run users -- disable-user --local --user USER_ID
npm run users -- enable-user --local --user USER_ID
```

签发默认 90 天，`--days` 支持 1–365。Token 文件必须在仓库外、尚不存在，父目录属于当前用户且权限 0700，文件权限 0600。先保存明文文件再登记哈希；失败不删除文件或直接重试，应检查远端是否已写成功。

CLI 必须显式选择 `--local` 或 `--remote`；后者固定 `dev`。远端 SQL 使用 `--command --json` 获取 RETURNING 行，本地使用受限临时 SQL 文件。**远端 `--file --json` 走导入 API，会夹带进度并返回汇总，而非查询行**，不能据解析失败断言 INSERT 未执行。

## 数据模型与 schema 维护

版本化迁移在 `worker-cloudflare/migrations/`：

- `0001_initial.sql`：照片、漫画任务、任务输入关联及 outbox 投递表。复合 owner 外键隔离任务和照片；任务恰好三张照片是未来 API 的校验责任，数据库位置范围不能保证数量。
- `0002_user_tokens.sql`：用户和 Token 哈希表，保留历史照片/任务 owner 并补建用户，不自动签发 Token。旧业务表未重建，因此 owner 尚无 users 外键；新上传通过鉴权确保有效用户。

`skills/deploy_cloudflare/references/schema.sql` 是当前完整结构快照，**不是应覆盖到 0001 的迁移文件**。修改数据库需新增版本化迁移，并同步完整快照。从仓库根目录重新生成可视化：

```bash
python3 -I skills/deploy_cloudflare/scripts/generate_schema.py
python3 -I skills/deploy_cloudflare/scripts/generate_schema.py --watch
```

生成器使用 Python 标准库和内存 SQLite，输出同目录 `schema.mmd` / `schema.html`；不要手改输出。监听更新文件后，浏览器仍需刷新。不据静态图推断远端 schema 已同步。

## 配置与部署边界

- `wrangler.local.jsonc` 使用本地占位数据库 ID；`wrangler.jsonc` 的 `env.dev` 绑定真实开发资源。不得把本地 ID 用于远端。
- 账号和数据库 ID 以当前配置与登录核对结果为准，不固定个人邮箱；换账号重新发现资源及签发凭据，不复制旧 Token 或删除旧资源。
- 资源操作前读取 `skills/deploy_cloudflare/SKILL.md`；代码部署前读取 `skills/deploy_worker/SKILL.md`。上传客户端契约见 `worker-cloudflare/USAGE.md`，开发/管理说明见该目录 README。
- 只有明确授权才执行 `npm run deploy:dev`、远端迁移及用户管理。编写代码、测试或文档不等于远端授权。OAuth 可由代理自动打开浏览器；不要申请全产品权限来消除 Wrangler 的缺失 scope 警告。
- 部署与远端迁移显式使用 `--env dev --remote`（部署用 `--env dev`）。先核对 Worker 是否属于本项目；认证错误不能当成资源不存在。
- 远端 smoke test 使用已授权的合成图/测试用户；上线 URL 和版本来自 Wrangler 实际返回。小图成功不保证 2048px 图片的套餐 CPU 预算，不能自动升级收费服务。
