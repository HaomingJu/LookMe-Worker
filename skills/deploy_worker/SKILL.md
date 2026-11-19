---
name: deploy-lookme-worker
description: 构建、测试并部署 LookMe 图片上传 Worker 到已配置的 Cloudflare 开发环境；自动执行 CLI，浏览器完成 OAuth，独立用户 Token 安全签发，自动完成部署、合成图上传及 D1/R2 验收，支持中断恢复。不默认部署生产或覆盖其他 Worker。
---

# LookMe 上传 Worker 部署

本 Skill 负责 `worker-cloudflare/` 中代码的部署，不代替资源开通 Skill。以自身路径向上定位仓库，使用相对项目路径；不固定个人账号、机器目录或历史数据库 ID。

## 范围与授权

- 用户明确要求部署时，自动执行检查、必要的网页登录、构建、部署和已授权的合成图片 smoke test，无需逐步确认 CLI。仅要求实现代码、修改文档或检查部署方案时，不部署、不创建远端用户或凭据、不发送远端图片。
- 默认仅 `dev`，目标 Worker 名从 `wrangler.jsonc` 的 `env.dev.name` 读取。生产部署、首次开放公开 HTTP 入口、替换用途不明的现有 Worker、撤销或轮换现有用户凭据需明确授权。开始时说明 workers.dev 的 HTTP 入口可公网访问，但上传必须 Bearer 鉴权，R2 桶仍私有；用户明确要求首次上线此上传 API 可视为授权该入口。
- 当前仅 `POST /photos`，不部署未实现的任务接口，不创建 Queues/VPS 或调用真实模型。

## 自动执行约定

- 所有 CLI 由代理执行，不要求用户复制命令、手动运行 `wrangler login` 或在回调成功后回复“已登录”。正常情况下用户只需网页批准 OAuth。
- 开始时展示目标账号、`dev` 环境、Worker 名和公网入口影响。完整部署验收会创建最多两个测试用户及凭据，并在开发 D1/R2 留下两张合成 JPEG；不接触真实照片或模型。用户明确请求完整部署验收可连续执行；只请求部署而未授权创建测试身份时，先完成部署和无凭据检查，再一次性确认用户/测试数据范围，不反复逐步骤询问。
- 用户只请求部署时，不把“尚无用户”当成上线阻塞；不能完成带凭据上传检查时，明确交接“已部署、上传未验证”。
- 先检测再变更；记录非秘密检查点，网络错误或 JSON 解析错误不等于远端没有写入。重跑复用已确认的项目资源和测试身份，不自动新建一批用户或轮换凭据。
- 本文命令均从 `worker-cloudflare/` 执行。检查锁文件、脚本和本版本 Wrangler help；命令所列默认名称以配置实际值为准。多账号歧义、账号不匹配、资源用途不明、生产目标、收费开通或危险迁移才暂停。

## 1. 本地验收

从 `worker-cloudflare/` 执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

使用锁文件版本。任一检查失败立即修复或报告，不跳过失败继续部署。`build` 是 Wrangler dry-run，不代表上线。确认 `src/index.ts`、迁移和绑定一致；JPEG 解码受到尺寸/内存限制，但纯 JS 解码耗费 CPU，不承诺免费套餐能处理所有 2048px 图片。实际 CPU 限制须按目标套餐验证，不自动升级计费。

## 2. 账号、资源与登录

- 使用项目 Wrangler `whoami` 匹配用户目标账号。所有远端命令固定本次目标 Account ID，检查环境变量/旧 API Token 是否覆盖 OAuth，不输出秘密。
- 若 D1/R2 未配置，先读取并按 `../deploy_cloudflare/SKILL.md` 完成开发资源和安全初始迁移。切换账号重新发现资源并更新 ID，不沿用旧账号资源引用。
- 核对 `env.dev` 的 `DB`、`PHOTOS`。owner 从 D1 的有效 Token 和 active 用户解析，不使用固定 owner vars。
- 不要只根据 Wrangler 的全产品缺失 scope 警告要求全权限。核对 `login --help` 和 `login --scopes-list`；D1/R2 有权限不代表有 Worker 部署权限。查询部署记录被拒绝且缺少 `workers_scripts:write` 时，由代理自动执行：

  ```bash
  npx wrangler login --scopes user:read account:read d1:write workers:write workers_scripts:write
  ```

  执行前说明 `workers:write` / `workers_scripts:write` 是较宽的管理权限，并更新本机登录凭据；网页批准作为 OAuth 确认，不给客户端该身份。输出等待状态，保持进程等待回调，成功后再次 `whoami` 并自动继续。仅浏览器打开失败时提供链接；超时/拒绝时明确阻塞，不无限重试，不申请无关产品权限。
- 执行 `npx wrangler deployments list --env dev` 检查目标 Worker。`No access` 是访问失败，不当成资源不存在；授权补齐后重查。明确返回 `This Worker does not exist` / `10007` 才视为首次部署。已有 Worker 需核对是本项目；用途不明时停止，不覆盖。
- 查询待迁移和现有表定义，确认 `photos`、`users`、`user_tokens` 匹配版本化迁移；新版上传代码依赖 `0002_user_tokens.sql`。新建空开发库可在明确部署授权下连续应用已审核的版本化迁移；已有库的 0002 新增用户表并补建历史 owner，不重建业务表，说明影响并按用户迁移授权执行。已有库变更按资源 Skill 的安全边界处理，不把 schema 模板当覆盖脚本。
- 查询两个桶的 dev-url 和自定义域，确认私有；不要启用 R2 公共访问。

## 3. 独立用户 Token

- 先完成 D1 用户表迁移。无需 Worker `UPLOAD_TOKEN` Secret 或 `UPLOAD_OWNER_ID`；旧共享 Token 不再有效，不保留认证后备。旧远端 Secret 不自动删除，待用户授权后退役。
- 明确用户创建/签发范围后，由代理执行 `npm run users -- create-user --remote`，获得 user_id，再执行 `npm run users -- issue-token --remote --user <user_id> --out <仓库外受限文件>`。已有用户按明确 user_id 签发，不重复创建身份；多个业务用户分别签发，不共用 Token。
- 管理脚本 `scripts/users.mjs` 使用开发环境 D1 管理权限，不提供给客户端。明文为 32 字节随机数，D1 只存 SHA-256 哈希；父目录须归当前用户且权限 0700，输出文件须未存在且权限 0600。代理不输出或请求用户粘贴 Token，只报告 user_id、token_id、到期时间和保存位置。默认 90 天，可按明确期限设置 `--days`。
- 本地验证对应命令改用 `--local`，不要复制远端凭据到测试环境；开发与生产独立签发。换 Cloudflare 账号后重新创建用户/签发凭据，不搬迁旧 Token 或照片。
- 在用户主目录下用 `mkdtemp` 创建独立的仓库外秘密目录，先核对 0700；不固定历史路径，不复用不明目录。每个 Token 用不同文件名，不覆盖旧文件。非秘密 `deployment.json` 也设为 0600，记录 Account ID、数据库 ID、Worker 名、实际 URL、版本、user_id/token_id、秘密文件路径、客户端 UUID、photo_id 和验收状态，不记录 Token/Authorization/图片内容。
- 每次创建用户成功立即保存 user_id；每次签发成功立即保存 token_id 和文件路径。先保存 Token 文件后注册哈希。脚本签发失败会保留本地文件并报告未确认成功；先核对 token_id/hash 是否已落库，避免重复签发。不存在用户/停用用户不能签发。无安全本地凭据时，smoke test 明确标为未验证，不自动轮换现有 Token。
- 撤销：`npm run users -- revoke-token --remote --token-id <id>`。停用/恢复：`disable-user` / `enable-user --remote --user <id>`。此类变更需对应用户授权；停用影响所有凭据，恢复不会恢复已撤销或过期凭据。轮换先签发和验证新 Token，再撤销旧 Token。

### 管理工具的 Wrangler 返回格式

- 必须使用仓库的 `scripts/users.mjs`，不要临时复制旧实现。远端 `d1 execute --file --json` 走文件导入，可能在 JSON 前打印上传进度，返回的是导入汇总，不是 `SELECT` / `RETURNING` 的结果。写入可能已成功，不能捕获解析错误后直接重试 INSERT。
- 本工具远端使用 `--command` 获取实际行结果，SQL 仅包含校验过的 ID、时间和高熵 Token 哈希，不包含 Token 明文；本地使用受限临时 SQL 文件。捕获 stdout/stderr，不把完整命令或底层错误打印到聊天。
- 遇到“操作失败”先查询用户/凭据 ID 和创建时间；如果用户已创建而未签发，复用此身份继续。若 Token 文件存在，安全读取并本地算哈希，以目标库确认是否注册；不输出哈希或明文。已注册则恢复检查点，未注册也不覆盖文件；用途或对应关系不明时停下。

## 4. 部署

```bash
npm run deploy:dev
```

用户表迁移就绪后可以先部署，再签发已授权的测试身份，不依赖 Worker Secret 初始化。检查部署返回的 Worker 名、版本、URL 和 bindings；Token 值不可出现在报告中。仅报告命令实际返回的 URL，不拼接假设域名。默认无 Worker 路由/自定义域配置；需要自定义域时另行确认，不修改现有站点路由。

部署后立即对实际 URL 执行轻量路由检查：`POST /photos` 无 Token 和不存在的正确格式 Token 均为 `401`，`GET /photos` 为 `405`，未知路径为 `404`。每个请求设置超时，不做无限重试；成功部署但验收失败不回滚数据库或删除资源。

## 5. 有界远端 smoke test

仅用合成 JPEG 或用户授权图片，不用用户私有照片做默认探测。合成数据会持久化到开发 D1/R2，部署开始时说明此影响；不自动删除记录或清桶。

1. 无 Token / 错 Token 上传返回 `401`；用户表迁移缺失或 D1 故障返回 `503`，不能当作鉴权测试通过。
2. 在本地用项目 `jpeg-js` 生成两张不同字节的小型 JPEG（例如 8×8），内存中构造 multipart，用受限文件 Token 发请求，不输出请求头。用户 A 首传 `201`，响应只含 photo_id、uploaded_at 及可选 captured_at，不含对象键。
3. 保留同一客户端 UUID、字节和元数据验证用户 A 重传 `200` 且 photo_id 不变，换字节 `409`。用户 B 使用同一客户端 UUID 和另一张 JPEG，应 `201` 且 photo_id 不同；失败请求不额外创建照片。
4. 用明确目标账号的 `d1 execute --env dev --remote --command ... --json` 查询本次客户端 UUID，两条记录分别归属两个测试用户，核对摘要、字节数、尺寸、MIME、来源及 UTC 时间。通过 `r2 object get <输入桶>/<object_key> --remote --pipe` 捕获二进制，在内存比较 SHA-256，不把对象字节输出到终端。不把 D1 mime_type 当成独立 R2 HTTP metadata 检查；工具不能直接取该 metadata 时明确记为未单独验证。
5. 生命周期操作仅明确授权后验证过期/撤销/停用用户均 `401`，不可停用真实用户做探测；只有本地做过的检查明确标注为本地结果。
6. 单次上传 2 MiB + 1 字节文件验证 `413`，短非法 JPEG 验证 `415`；不做压力测试或大图 CPU 消耗探测。

业务凭据在脚本内从受限文件/环境读取，避免拼成会显示秘密的 shell 命令。curl 示例只是说明接口；代理应使用不会打印请求头的安全测试脚本执行。

## 最终核对与交接

- 再次执行 `deployments list --env dev` 核对当前流量版本及 URL，`d1 migrations list` 确认无遗漏；查询本次用户/Token/照片记录和 `PRAGMA foreign_key_check`。已有业务数据时按本次 ID 范围检查，不要求全库计数等于测试样本数量。
- 验收记录写入受限目录并说明保留了哪些合成数据。配置、管理 CLI 修复不改 Worker 运行代码时，无需重复部署；若运行代码变了则重新验收并获授权后更新部署。
- 不上传验收报告、凭据或照片到外部服务。不要把一次小图上传成功宣称为完整性能、所有尺寸或生产安全验收。


输出目标账号/环境、Worker 名、实际 URL、版本、迁移状态、通过/失败/未验证检查和用户 Token 保存位置（不含值）。上传 API 不等于公开下载 API；结果下载、CORS、速率限制和孤儿对象清理尚未实现。失败重试复用客户端 UUID 和同一 JPEG；R2/D1 没有跨服务事务，D1 失败可能留下孤儿对象，不盲删。

最后输出 ✅ 完成、⚠️ 部分完成或 🔴 阻塞。不得无授权提交、推送、生产部署、改网络、升级套餐或调用付费模型。
