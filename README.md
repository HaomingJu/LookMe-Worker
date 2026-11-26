# LookMe-Worker

照片上传后异步生成四格漫画的服务。本仓库包含五个独立 npm 项目（见 [`worker-cloudflare/`](worker-cloudflare/)），本文档面向开发者，说明如何管理用户、生成故事/漫画，以及部署各个 Worker。

## 项目概览

| 目录 | Worker 名（dev） | 域名 / 入口 | 用途 |
| --- | --- | --- | --- |
| `worker-cloudflare/worker-upload/` | `lookme-api-dev` | `api.fudaixuexue.eu.cc` | 照片上传 API，写 D1/R2，投递 Outbox 入队 |
| `worker-cloudflare/worker-image2txt/` | `lookme-image2txt-dev` | 无 HTTP（Queue-only） | 图片转文字消费者，调用 Workers AI |
| `worker-cloudflare/worker-story/` | `lookme-story-dev` | `story.fudaixuexue.eu.cc` | 故事生成（手动 HTTP） |
| `worker-cloudflare/worker-comic/` | `lookme-comic-dev` | `comic.fudaixuexue.eu.cc` | 漫画生成（手动 HTTP） |
| `worker-cloudflare/worker-debug/` | `lookme-debug-dev` | `lookme.fudaixuexue.eu.cc` | 只读调试页（照片/故事/漫画） |

五个项目共享同一个 D1 数据库 `lookme-dev`（真实 ID `8ca73bf2-a8d9-4d17-a393-105a9f63622d`）和 R2 桶。所有 D1 迁移统一放在 `worker-cloudflare/worker-upload/migrations/`，各 Worker 的 `migrations_dir` 都指向该目录，不复制迁移。

> ⚠️ 部署与远端迁移属于**明确授权操作**，编写代码、测试或文档不等于远端授权。执行任何 `deploy:dev` / `--remote` 命令前请确认已获授权。

## 用户管理（`users.mjs`）

用户管理通过 `worker-cloudflare/worker-upload/scripts/users.mjs` 完成，直接读写开发 D1 数据库。命令统一从 `worker-cloudflare/worker-upload/` 目录执行，且**必须显式指定 `--local` 或 `--remote`**（远端固定为 `dev` 环境）。

`--local` 操作本机 Wrangler 用 SQLite 模拟的本地 D1；`--remote` 操作 Cloudflare 上真实的 dev D1。两者数据不互通。本地调试用 `--local`，操作线上真实用户/照片/token 用 `--remote`。

用户有两个标识：

- `user_id`：服务端生成的不透明 UUID，是数据库主键，保留不变。
- `username`：新增的人类可记唯一用户名，与 `user_id` 一一对应，避免用户名重复。

规则：用户名限 1–64 位字母、数字、下划线或短横线（`[A-Za-z0-9_-]`），唯一性不区分大小写（`alice` 与 `Alice` 视为同名）。历史从 `photos`/`comic_jobs` 补建的用户 `username` 为 `NULL`，需用 `rename-user` 补记。`--user` 参数统一接受**用户名或 user_id**。

### 命令速查

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `create-user` | 创建用户 | `--username`（必填） |
| `list-users` | 列出所有用户 | — |
| `show-user` | 查看单个用户 | `--user` |
| `list-tokens` | 列出某用户名下的所有 token | `--user` |
| `rename-user` | 重命名用户 | `--user`、`--username` |
| `delete-user` | 删除用户 | `--user` |
| `issue-token` | 签发 Token | `--user`、`--out`、`--days`（可选） |
| `revoke-token` | 撤销 Token | `--token-id` |
| `disable-user` | 停用用户 | `--user` |
| `enable-user` | 启用用户 | `--user` |

### 示例命令（本地）

```bash
cd worker-cloudflare/worker-upload

# 创建用户（用户名必须唯一，重名会提示“创建失败：用户名已存在”）
npm run users -- create-user --local --username alice

# 列出所有用户
npm run users -- list-users --local

# 查看单个用户（按用户名或 user_id）
npm run users -- show-user --local --user alice

# 列出某用户名下的所有 token（含 token_id 和状态，方便复制后注销）
npm run users -- list-tokens --local --user alice

# 重命名用户（用于给历史用户补记用户名）
npm run users -- rename-user --local --user alice --username alice2

# 签发 Token（默认 90 天）
npm run users -- issue-token --local --user alice --out "$HOME/.lookme-credentials/alice.token"

# 签发 Token（指定有效期 1–365 天）
npm run users -- issue-token --local --user alice --days 30 --out "$HOME/.lookme-credentials/alice.token"

# 撤销 Token（先 list-tokens 拿到 token_id）
npm run users -- revoke-token --local --token-id TOKEN_ID

# 停用 / 启用用户
npm run users -- disable-user --local --user alice
npm run users -- enable-user --local --user alice

# 删除用户（仅在该用户无任何关联 Token、照片、任务、故事或漫画记录时才会执行）
npm run users -- delete-user --local --user alice
```

### 示例命令（远端 dev）

将上方的 `--local` 换成 `--remote` 即可，远端目标固定为配置的 `dev` 环境：

```bash
npm run users -- create-user --remote --username alice
npm run users -- issue-token --remote --user alice --out /受限目录/dev-user.token
npm run users -- list-tokens --remote --user alice
npm run users -- disable-user --remote --user alice
```

### Token 文件安全要求

- 文件必须位于**仓库外**、且**尚不存在**，权限 `0600`。
- 父目录必须归当前用户所有，且不允许组/其他用户写入（可为 `0700`/`0750`/`0755`）。
- 明文 Token 仅写入该文件；D1 只保存 SHA-256 哈希。工具不打印 Token 明文。
- 一个用户可持有多条 Token；签发新 Token 后应验证再撤销旧 `token-id`。
- 注销 Token 前先用 `list-tokens` 拿到 `token_id`，再用 `revoke-token --token-id` 撤销。
- 停用用户（`disable-user`）后，该用户不再出现在调试网站的用户列表中。

### 删除用户边界

`delete-user` 会先检查关联数据，存在以下任一记录时拒绝删除（避免留下孤儿数据）：`user_tokens`、`photos`、`comic_jobs`、`stories`、`story_runs`、`comic_runs`。仅当用户完全无关联时才执行删除。

## 各 Worker 部署与命令

### 本地命令（通用）

每个 Worker 目录都支持以下本地命令（有差异处见各小节）：

```bash
npm ci                 # 安装锁定依赖
npm run typecheck      # TypeScript 类型检查
npm test               # 本地 mock 测试（不连接远端、不调用模型）
npm run build          # Wrangler dry-run 打包（不代表上线）
npm run dev            # 本地 Wrangler 开发服务（使用 wrangler.local.jsonc）
```

### 自动分析管道（upload + image2txt）

上传 Worker 与图片转文字消费者构成自动分析管道，**必须按固定顺序一起部署**（先消费者、后生产者），通过仓库根目录的 `pipeline.mjs` 统一执行：

```bash
# 从仓库根目录
node worker-cloudflare/scripts/pipeline.mjs check    # 离线校验
node worker-cloudflare/scripts/pipeline.mjs plan     # 展示目标与完整步骤
node worker-cloudflare/scripts/pipeline.mjs deploy-dev --confirm-dev   # 实际部署（需授权）
```

也可从任一 Worker 目录执行等价的 npm 脚本：

```bash
cd worker-cloudflare/worker-upload
npm run config:check
npm run pipeline:plan
npm run pipeline:deploy:dev -- --confirm-dev
```

部署脚本会：校验配置/版本锁/两个 Worker 连接、执行 typecheck + 测试 + dry-run、核对登录与队列、应用缺失迁移、先发布消费者再发布上传生产者与 Cron。脚本**不会**上传测试图、补投历史照片或调用真实模型。详细说明见 [`worker-cloudflare/PIPELINE.md`](worker-cloudflare/PIPELINE.md)。

> 上传 Worker 单独也有 `npm run deploy:dev`，但自动分析管道请优先走 `pipeline.mjs`，以保证消费者先就绪。

### worker-story（故事）

域名 `story.fudaixuexue.eu.cc`，独立 HTTP Worker，不参与自动管道。

```bash
cd worker-cloudflare/worker-story
npm ci
npm run config:check
npm run typecheck
npm test
npm run build
npm run deploy:dev      # 部署（predeploy 钩子自动跑 config:check + typecheck + test + preflight）
```

### worker-comic（漫画）

域名 `comic.fudaixuexue.eu.cc`，独立 HTTP Worker，只由本地 CLI 手动触发，不参与自动部署或排队。

```bash
cd worker-cloudflare/worker-comic
npm ci
npm run typecheck
npm test
npm run build
npm run deploy:preflight                          # 在线只读预检账号/域名
npx wrangler deploy --env dev                     # 部署（该目录无 deploy:dev 脚本，直接调 wrangler）
```

### worker-debug（调试页）

域名 `lookme.fudaixuexue.eu.cc`，只读调试页，绑定 `DB`、`PHOTOS`、`COMICS`，不写库、不改桶。

```bash
cd worker-cloudflare/worker-debug
npm ci
npm run typecheck
npm test               # 后端 node:test + Playwright 浏览器测试
npm run build
npm run deploy:dev
```

## 故事生成（Story）

故事 Worker 独立部署，域名 `story.fudaixuexue.eu.cc`。从 `worker-cloudflare/worker-story/` 目录执行，按北京时间上传日期聚合当天照片，AI 自动决定故事数量（1–8 个且不超过照片数），每个故事 4 格。

前置条件：目标用户已上传照片，且这些照片已有**成功**的图片分析（摘要）。

### 基本用法

```bash
cd worker-cloudflare/worker-story
npm run story -- --base-url https://story.fudaixuexue.eu.cc \
  --token-file /受限目录/user.token \
  --date YYYY-MM-DD \
  --confirm-model-call
```

### 完整参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--base-url URL` | ✅ | 故事 Worker 地址；HTTP 仅允许本地回环 |
| `--token-file PATH` | ✅ | 当前用户的 Token 文件（0600） |
| `--date YYYY-MM-DD` | ✅ | 按北京时间上传日聚合 |
| `--confirm-model-call` | ✅ | 显式确认调用模型（会产生 Workers AI 费用） |
| `--model MODEL_ID` | 否 | 指定模型，默认 Qwen `@cf/qwen/qwen3.8-27b` |
| `--story-version VERSION` | 否 | 锁定历史版本；与 `--model` 冲突时拒绝 |
| `--out PATH` | 否 | 结果存到尚不存在的 0600 文件；省略则写标准输出 |
| `--list-models` | — | 离线列出可选模型与默认版本，不读 Token、不调用模型 |
| `--help` | — | 打印用法，不读 Token、不访问网络 |

### 可选模型

| `--model` 取值 | 对应版本 | 说明 |
| --- | --- | --- |
| `@cf/qwen/qwen3.8-27b` | `v5` | **默认**，Qwen 文本模型，自动决定故事数量 |
| `@cf/google/gemma-4-26b-a4b-it` | `v5-gemma` | Gemma 文本模型，同样自动决定故事数量 |

用 `npm run story -- --list-models` 可离线列出完整模型列表与各自默认版本。若只指定 `--story-version` 而不指定 `--model`，会按版本锁定对应的模型；两者同时指定但互相矛盾时会被拒绝，不静默改模型。

### 注意事项

- 超时或断连**可能已产生费用**，不能把重跑当作幂等恢复。
- Token 从受限文件读取，不传明文参数。

## 漫画生成（Comic）

漫画 Worker 独立部署，域名 `comic.fudaixuexue.eu.cc`。从 `worker-cloudflare/worker-comic/` 目录执行，对已生成的某个故事（`story_id`）生成一张 1024×1536 竖版四格漫画。

前置条件：目标用户已有**成功**的故事（从故事结果里取 `stories[].story_id`）。

### 基本用法（generate）

```bash
cd worker-cloudflare/worker-comic
npm run comic -- generate --base-url https://comic.fudaixuexue.eu.cc \
  --token-file /受限目录/user.token \
  --story-id UUID \
  --confirm-model-call
```

`generate` 可选参数：

- `--model MODEL_ID`：指定模型，默认 `@cf/black-forest-labs/flux-2-klein-9b`。
- `--photo-id UUID ...`：最多 3 张、从该故事原图中指定参考图；省略则自动跨分镜选取代表照片。
- `--run-id UUID`：显式指定 run_id；省略则每次生成新 UUID。

### 其他子命令（不调用模型）

```bash
# 列出某故事下的历史生成（最多 50 条，倒序）
npm run comic -- list --base-url https://comic.fudaixuexue.eu.cc \
  --token-file /受限目录/user.token --story-id UUID [--cursor CURSOR]

# 查询某次生成状态
npm run comic -- status --base-url https://comic.fudaixuexue.eu.cc \
  --token-file /受限目录/user.token --run-id UUID

# 下载成图（校验 MIME/字节数/SHA-256）
npm run comic -- download --base-url https://comic.fudaixuexue.eu.cc \
  --token-file /受限目录/user.token --run-id UUID --out /受限目录/image.png
```

### 可选模型

| `--model` 取值 | 用途 | 适配方式 |
| --- | --- | --- |
| `@cf/black-forest-labs/flux-2-klein-9b` | **默认**，首选质量基线 | Workers AI multipart，参考图长边 ≤500px，固定 4 步 |
| `@cf/black-forest-labs/flux-2-klein-4b` | 快速预览 | 输入协议同 9B |
| `openai/gpt-image-2.6-flare` | 质量对照 | Workers AI binding，JPEG data URL 输入，medium PNG，参考图长边 ≤1024px，走统一计费余额 |

用 `npm run comic -- --list-models` 可离线列出完整可选模型列表。

### run_id 语义

- 每次 `generate` 产生一个新 `run_id`，对应**一次**生成；默认每次新 UUID，仅在明确要再生成一份结果时这样做。
- CLI 提交前把 `run_id` 打到 stderr，**请保留以便查询**。
- 超时/断连后，先 `status` 查询，不要盲目重发。
- 相同参数复用同一 `--run-id` 只返回原记录、不再次调用模型；同一 ID 换参数返回冲突。

## 端到端工作流

从零到生成漫画的完整链路：

```bash
# 1. 创建用户并签发 Token
cd worker-cloudflare/worker-upload
npm run users -- create-user --remote --username alice
npm run users -- issue-token --remote --user alice --out /受限目录/alice.token

# 2. 上传照片（通过上传 API，自动入队分析）
#    使用上面的 Token 调 POST /photos（见 worker-upload/README.md）

# 3. 生成故事（需照片已有成功分析）
cd ../worker-story
npm run story -- --base-url https://story.fudaixuexue.eu.cc \
  --token-file /受限目录/alice.token --date YYYY-MM-DD --confirm-model-call
# 从结果 JSON 取 stories[].story_id

# 4. 生成漫画
cd ../worker-comic
npm run comic -- generate --base-url https://comic.fudaixuexue.eu.cc \
  --token-file /受限目录/alice.token --story-id STORY_ID --confirm-model-call
# 保留输出的 run_id，用 status/download 查询或下载

# 5. 在调试页查看（只读）
#    打开 https://lookme.fudaixuexue.eu.cc ，登录后按用户浏览照片/故事/漫画
```
