# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 可复现与配置原则

- **尽量可复现，通过配置文件复现设置，而不是依赖 AI 每次重新思考和临时决定操作步骤。** 把确定的配置、版本约束、校验、迁移、部署顺序和恢复流程保存到仓库中的配置文件、脚本及测试；文档给出固定入口和明确前置条件。
- **所有 Cloudflare 配置修改统一写入 Wrangler 配置文件，由 Wrangler 应用。** 不绕过文件通过控制台或管理 API 修改绑定、队列生产者/消费者、Cron、AI binding、环境参数、路由或日志设置。若有步骤不能通过 Wrangler 完成，先提醒用户，不擅自换方式。
- D1 表结构是版本化 SQL 迁移，不是 wrangler.jsonc 字段；由 Wrangler migrations 命令执行，并同步完整 schema 快照。真实用户数据/图片的处理、历史补投及模型调用与配置变更分开授权。
- 可配置不等于可静默改变历史语义：模型、提示词、生成参数按分析版本固定；新增版本，保留旧版本配置，配置校验失败时停止发布。

## 项目现状与架构

LookMe 的目标是照片上传后异步生成四格漫画。**当前实现图片上传、独立用户 Token 鉴权、事务Outbox自动入队/定时补投，以及仅Queue消费的图片转文字Worker（自动管道已部署dev，Gemma v2已通过真实新上传验收）**；独立漫画 Worker 已实现并只做本地验证；自动漫画建单尚未接入。`TODOs.md` 是规划清单，不是当前实现或远端操作授权的依据。

仓库包含五个独立 npm 项目：`worker-cloudflare/worker-upload/`、`worker-image2txt/`、`worker-story/`、`worker-debug/` 和 `worker-comic/`，没有仓库根目录 npm workspace。各自入口为 `src/index.ts`，使用 Cloudflare 原生 bindings；上传 Worker 使用 `jpeg-js`，没有路由框架。自动分析管道只包含上传端与图片转文字消费者；故事与调试 Worker 独立发布。

上传路径：`POST /photos` → 在 D1 查验 Token 哈希、有效期、撤销状态及 active 用户 → 有界读取 multipart → JPEG 文件/尺寸/实际解码验证 → SHA-256 → 按认证 owner 和客户端 UUID 查幂等记录 → 写私有 R2 → D1同一batch插入照片与Outbox → 返回photo_id和时间，waitUntil尝试入队；Cron补投待发记录。

- 运行时使用 `DB`、`PHOTOS`；配置中的 `COMICS` 桶目前未被上传代码使用。
- 用户 owner 只能来自认证查询，不来自请求正文。不同用户的客户端 UUID 独立；同用户同 UUID、不同字节或关键元数据返回 `409`。
- R2 与 D1 无跨服务事务。并发由 `UNIQUE(owner_id, client_photo_id)` 收敛；D1 失败或并发竞争可能留下孤儿 R2 对象，代码不会盲删。
- JPEG 上限 2 MiB、每边 2048 px，请求总量 3 MiB；先检查 SOF 尺寸再完整解码。服务端不重编码、旋转或清除 EXIF。
- 用户 Token 不是 Cloudflare 管理凭据：`lm_` + 64 个小写十六进制字符（32 随机字节），D1 仅存 SHA-256。旧 `UPLOAD_TOKEN` / `UPLOAD_OWNER_ID` 不再使用。

## 开发命令

以下上传命令均从 `worker-cloudflare/worker-upload/` 执行：

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

### 自动管道固定入口

从仓库根目录执行 `node worker-cloudflare/scripts/pipeline.mjs check` / `plan`；明确确认后使用 `deploy-dev --confirm-dev`。两边package.json也提供config:check、profiles:lock、pipeline:plan、pipeline:deploy:dev。脚本仅用Wrangler修改远端配置，不创建未知资源或自动调用模型。

明确授权的历史补跑用 `backfill --owner UUID --version v2 --max-photos N` 先预览，加 `--confirm-model-calls` 才通过Wrangler写Outbox。数量超过上限全部拒绝；任何已有同版本Outbox/分析记录都排除，不清除needs_review。发布和补跑是独立操作。

### 测试运行方式

`test/upload.test.ts` 用 esbuild 将入口打包给 Miniflare，按文件名顺序应用所有 SQL 迁移，使用临时真实 D1/R2 验证上传；存储故障用 mock 验证。Miniflare 5 使用官方 `convertV4MiniflareOptions` 转换配置。Node 原生 FormData 先通过 Request 序列化为字节/headers，再交给 Miniflare，避免两套 FormData 实现不兼容。

`test/users.test.ts` 测试管理员 CLI 的随机凭据、输出权限、参数验证及失败行为，mock 子进程以避免远端管理操作。测试硬编码 Token 是本地测试夹具，不是部署凭据。

`test/clients/` 是五语言可执行上传客户端及本地协议回归工具。C/C++ 的 CMake 构建、临时 mock 服务和 40 项上传协议及参数/帮助检查由 `verify.py` 管理；这是传输测试，不取代上述 D1/R2 集成测试，也不自动运行远端测试。

`upload_batch_cpp` 是独立批量客户端，不修改 Worker API；libcurl multi 最多8并发，首次自动在用户主目录创建受限批次文件并输出 STATE_FILE，保存每张UUID和完成状态；失败时用 --state 恢复原文件，而非生成新UUID。用 `verify_batch.py` 本地验证并发/连接复用、失败及中断恢复；具体命令见 `test/clients/BATCH.md`。C有独立libcurl multi实现，JS用undici连接池，Python用持久连接线程池，curl用parallel进程；脚本不包装C++。Python/JS/curl共享JSON状态格式，C和C++各自格式不同。

## 图片转文字 Queue Worker

`worker-cloudflare/worker-image2txt/` 只导出 `queue()`，关闭 workers.dev、预览 URL 和 HTTP 路由。消息只含 `{ photo_id, analysis_version: "v2" }`；从 D1 取可信 object_key，再读取同一私有 `PHOTOS`，核对大小和 SHA-256 后调用原生 Workers AI Gemma 并写入 `photo_analyses`。上传Worker通过Outbox自动投递新上传，旧照片不自动补跑。配置及固定部署入口见 `worker-cloudflare/PIPELINE.md`。

- AI配置集中在 `worker-cloudflare/config/analysis-profiles.json`，指纹锁在同目录lock文件；运行时及发布前校验，`profiles:lock`只追加新版本。默认版本仅影响新上传，已有Outbox按原版本消费。
- `v2` 固定 `@cf/google/gemma-4-26b-a4b-it`，通过 `AI` binding 调用，关闭 thinking、最多512 completion tokens、非streaming、中文事实描述。无需 Moondream Secret；v1保留历史语义，不自动映射为v2。改模型/语义要新版本，不能覆盖已有分析。
- 条件更新原子领取；lease 120 秒，准备阶段最多领取 5 次并退避重试；模型请求及正文合计超时 45 秒。
- 发请求前持久化 provider_attempt_id；只有成功响应才允许调用。模型 timeout、断连、错误响应或持久化不确定进入 needs_review，绝不自动清除调用标记/盲重调。未提交的过期任务可重领；已提交的过期任务需核查。
- 仅 succeeded 落库后 ack；其他失败 retry，由配置的 8 次重试上限转 DLQ，不自动消费/重放 DLQ。队列/DLQ、远端迁移、Secret、部署、真实模型调用需要另行授权。
- 结构化日志含阶段边界/实际耗时、固定错误码、UUID、字节数和结果长度，不含秘密/图片/正文。dev 启用 invocation logs；CPU 强制终止不保证 catch/日志，需结合平台 exceededCpu 和 CPU time，不能用 wall_ms 冒充 CPU。
- 从该目录运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`（dry-run）。测试使用临时真实本地 D1/R2、mock AI.run、真实本地 Queue 及 DLQ，不连接远端。详细状态和人工核查边界见该目录 README。

## 自动分析配置和固定发布入口

- `worker-upload/wrangler*.jsonc`声明IMAGE2TXT_QUEUE生产者、UTC每分钟Cron、PHOTO_ANALYSIS_ENABLED及Outbox参数；consumer文件声明消费者/DLQ/AI。所有变更通过Wrangler文件应用。
- `node worker-cloudflare/scripts/pipeline.mjs check` / `plan`为离线检查/展示；`deploy-dev --confirm-dev`先检查/测试，再固定使用Wrangler执行迁移、部署消费者、部署上传端和Cron，最后核对。脚本不创建未知资源、不改套餐、不补历史照片、不执行额外模型测试。
- Outbox和photos同一D1 batch提交；Queue失败不改变已保存照片的成功响应。重复上传只补投已有任务，不为旧照片或新默认分析版本建任务。
- 开关false会暂停新任务创建及Outbox投递，但不取消已经在Queue/推理中的任务；期间上传的照片重新开启后不自动补跑。
- v1已退役；禁止修改/删除已锁定profile，新增版本运行`npm run profiles:lock`，先消费者支持再切新任务默认版本。配置不是万能模型兼容层，只支持已实现的适配器协议。

## 故事与调试 Worker

- `worker-cloudflare/worker-story/` 使用用户 Token 手动调用 `POST /stories`，读取指定用户当天摘要，不读 R2、不使用 Cron/Queue；0005迁移后先登记生成批次，模型成功且结果事务保存后返回JSON，故事有稳定story_id供后续漫画引用；故事自动数量、模型选择、版本锁、费用估算和错误诊断见该目录 README。当前新版本通过本地 mock 验证，不从历史 v4 验收推断新模型真实可用性。
- `worker-cloudflare/worker-debug/` 提供受密码保护的只读照片/故事调试页，故事按上传日读取D1持久化批次并显示模型、耗时、用量和费用估算；单独配置与发布，不与上传自动分析管道混合部署。
- `worker-comic/` runs only on explicit CLI requests and preserves multiple results per story in D1/private R2. / 仅 CLI 主动触发；同一故事的多次结果分别保存在 D1/私有 R2。不参与自动部署或排队。见 [双语说明](worker-cloudflare/worker-comic/README.md)。
- 各目录有自己的 `package.json`；从仓库根目录运行 npm 命令时使用 `npm --prefix worker-cloudflare/<项目目录> ...`，避免根目录 ENOENT。故事结果、秘密文件、Wrangler 缓存不提交 Git。

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

共用版本化迁移在 `worker-cloudflare/worker-upload/migrations/`；图片转文字 Worker 的 `migrations_dir` 指向该目录，不复制迁移：

- `0001_initial.sql`：照片、漫画任务、任务输入关联及 outbox 投递表。复合 owner 外键隔离任务和照片；任务恰好三张照片是未来 API 的校验责任，数据库位置范围不能保证数量。
- `0002_user_tokens.sql`：用户和 Token 哈希表，保留历史照片/任务 owner 并补建用户，不自动签发 Token。旧业务表未重建，因此 owner 尚无 users 外键；新上传通过鉴权确保有效用户。
- `0003_photo_analyses.sql`：以 `(photo_id, analysis_version)` 主键独立保存分析状态和文字结果；外键引用照片且禁止删除被引用照片，约束 lease、调用标记与终态。
- `0004_photo_analysis_dispatch.sql`：上传事务Outbox，只新建表/索引，不回填历史照片；原子领取、租约、持久退避、投递标记。Queue接收不等于分析成功。
- `0005_story_runs.sql`：故事生成批次、输入照片/摘要快照、独立story_id及四格JSON；模型前登记、成功事务落库，失败不自动重调。2026-11-23已获准应用到dev并发布story/debug；后续迁移/发布仍须另行授权，之后另经授权完成一次Qwen/v5真实生成并验证D1持久化；不据此授权后续模型调用。

- `0006_comic_runs.sql` adds owner-scoped comic generation history only. / 只新增按用户隔离的手动漫画历史表，不改旧任务、不回填。

`skills/deploy_cloudflare/references/schema.sql` 是当前完整结构快照，**不是应覆盖到 0001 的迁移文件**。修改数据库需新增版本化迁移，并同步完整快照。从仓库根目录重新生成可视化：

```bash
python3 -I skills/deploy_cloudflare/scripts/generate_schema.py
python3 -I skills/deploy_cloudflare/scripts/generate_schema.py --watch
```

生成器使用 Python 标准库和内存 SQLite，输出同目录 `schema.mmd` / `schema.html`；不要手改输出。监听更新文件后，浏览器仍需刷新。不据静态图推断远端 schema 已同步。

## 配置与部署边界

- `wrangler.local.jsonc` 使用本地占位数据库 ID；`wrangler.jsonc` 的 `env.dev` 绑定真实开发资源。不得把本地 ID 用于远端。
- 账号和数据库 ID 以当前配置与登录核对结果为准，不固定个人邮箱；换账号重新发现资源及签发凭据，不复制旧 Token 或删除旧资源。
- 资源操作前读取 `skills/deploy_cloudflare/SKILL.md`；代码部署前读取 `skills/deploy_worker/SKILL.md`。上传客户端契约见 `worker-cloudflare/worker-upload/USAGE.md`，开发/管理说明见该目录 README。
- 只有明确授权才执行 `npm run deploy:dev`、远端迁移及用户管理。编写代码、测试或文档不等于远端授权。OAuth 可由代理自动打开浏览器；不要申请全产品权限来消除 Wrangler 的缺失 scope 警告。
- 部署与远端迁移显式使用 `--env dev --remote`（部署用 `--env dev`）。先核对 Worker 是否属于本项目；认证错误不能当成资源不存在。
- 远端 smoke test 使用已授权的合成图/测试用户；上线 URL 和版本来自 Wrangler 实际返回。小图成功不保证 2048px 图片的套餐 CPU 预算，不能自动升级收费服务。
