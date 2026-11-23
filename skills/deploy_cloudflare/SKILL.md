---
name: deploy-cloudflare
description: 自动配置 LookMe-Worker 开发环境的 Cloudflare D1、私有 R2 和 Worker 绑定，完成本地及远端初始迁移；由代理执行 CLI，用户通常只需在浏览器完成 OAuth 授权。上传联调、Queues、VPS 和部署按明确请求执行。
---

# LookMe Cloudflare 部署

当前 Cloudflare TypeScript 上传 Worker 保存图片，独立 image2txt Queue Worker 通过 Workers AI binding 调用 Gemma 并保存文字；D1 存元数据/分析结果，R2 存私有图片。建单、漫画生成、查询及 VPS HTTP pull 是后续规划，不据此自动开通资源。image2txt 部署见 `../deploy_worker/references/image2txt.md`。

- 配置或更改 D1/R2 前，读 [资源、权限与数据设计](references/storage.md) 和 [初始 SQL 模板](references/schema.sql)。
- 修改 `references/schema.sql` 后，执行 `python3 -I scripts/generate_schema.py`（从本 Skill 目录），同步生成 `references/schema.mmd` 和 `references/schema.html`；开发时可加 `--watch`。使用方法见 [Schema 可视化](references/schema-visualization.md)。可视化不代替版本化迁移。
- 联调上传、建单和下载时，读 [图片上传与下载](references/image-upload.md)。

## 配置修改与可复现入口

所有Cloudflare配置修改必须保存在Wrangler配置文件并通过Wrangler应用；不直接通过控制台或管理API改绑定/路由/队列触发器/Cron/参数/日志。无法由Wrangler完成的步骤先提醒用户。D1 schema仍使用版本化SQL及Wrangler migrations；首次创建资源不能伪称只靠现有JSONC完成，按资源授权单独处理。

自动分析管道的确定流程见 `../../worker-cloudflare/PIPELINE.md`；执行仓库 `worker-cloudflare/scripts/pipeline.mjs check|plan|deploy-dev --confirm-dev`，而不是每次重新让AI设计步骤。新Outbox迁移不回填历史照片；默认分析版本和生成参数由共享JSON/profile锁决定。

## 自动化范围与默认值

用户请求实际配置开发环境 D1/R2 时，连续执行本地准备、浏览器登录、资源查重、创建缺失资源、写入绑定、安全初始迁移和验证，不为每个步骤重复索要确认，也不把 CLI 命令交给用户执行。开始时说明范围与默认值；用户只需在浏览器登录并批准权限。仅修改或审阅本 Skill/文档的请求不授权任何远端操作。

| 配置 | 默认值 |
| --- | --- |
| 环境 | `dev`，独立于生产 |
| D1 / binding | `lookme-dev` / `DB` |
| 输入 R2 / binding | `lookme-dev-photos` / `PHOTOS` |
| 成品 R2 / binding | `lookme-dev-comics` / `COMICS` |
| Worker 配置名 | `lookme-api-dev`，仅写配置，不默认部署 |

已有配置和用户明确指定的名称优先。目标账号使用用户指定账号；未指定且登录身份仅有一个账号时，展示该账号并作为开发目标。多个账号无法唯一匹配、登录邮箱不匹配或同名资源用途不明时暂停询问。不要把邮箱当成 Account ID，也不要把开发默认值套到生产。

## 跨账号与跨机器复现

- 本 Skill 是 LookMe 的可复现部署流程，不绑定某个个人账号或机器。使用 Skill 所在目录定位 `references/`，向上定位仓库，再使用相对项目路径 `worker-cloudflare/worker-upload/` 或 `worker-cloudflare/worker-image2txt/`；不得硬编码用户主目录、邮箱、Account ID 或历史数据库 ID。
- 正常前提为 Node.js/npm 可用、Cloudflare 账号已开通 D1/R2 且有足够配额。首次配置或换账号时，用户只需在网页登录目标账号并授权；需要开通计费、安装系统运行环境或解决账号冲突时，明确说明额外前提，不承诺无条件零交互。
- 已有 Wrangler 配置中的 Account ID 只是当前绑定记录，不是不可更改的部署目标。用户明确要求换账号时，以新登录目标为准，重新查重并取得新账号的真实数据库 ID；保持逻辑 binding 和默认资源名称一致，只替换目标资源引用。
- 同一配置在同一账号重跑应复用已确认资源和已应用迁移，不重复创建、不重复建表。已由本项目配置且 schema 一致的开发资源可复用；仅名称相同、无项目归属依据的资源不得自动接管。
- 跨账号切换只创建和初始化新账号资源，并更新本地开发绑定；不迁移照片、业务数据或运行秘密，不删除旧账号资源。账号切换前保留旧的非秘密配置副本（文件名含旧 Account ID），便于恢复；不要复制 OAuth、S3 或其他秘密。
- 每次远端资源命令通过该版本支持的账号选择机制显式指定目标账号（例如命令作用域中的 `CLOUDFLARE_ACCOUNT_ID`），并检查已有环境变量/API Token 是否会覆盖刚完成的 OAuth 登录。只检查凭据是否存在，不输出值；身份不一致时停下，不盲目沿用旧凭据。
- 工具版本来自项目锁文件，schema 来自版本化迁移；不把某次查询到的最新版或某次运行的真实 ID 固定在 Skill 中。跨机器使用相同锁文件和迁移以复现同样流程。

## 执行顺序

### 1. 检查与本地准备

- 从仓库根目录检查 Git 状态、项目指令、`TODOs.md`、Wrangler 配置、锁文件、迁移和 API 路由，保留已有实现。历史待办的“未授权/未执行”记录不是当前用户配置请求的替代品，也不能作为已完成证明。
- 使用项目已锁定的 Wrangler 版本；缺失时查询可用版本，安装为项目内精确版本的开发依赖并生成锁文件，不全局安装，不升级已有版本。检查 Node.js 兼容性。不要用 `npm init -y` 留下无关元数据或必定失败的默认测试脚本。
- 忽略 `node_modules/`、`.wrangler/`、`.dev.vars*`、`.env*`，仅补充缺失规则，不覆盖已有忽略配置。
- 把 SQL 模板与已有迁移对齐。优先保留并执行仓库已有的版本化迁移。`schema.sql` 是最新完整结构快照，不能把它覆盖到已有 `0001_initial.sql`，否则会与后续迁移重复建表；仅无迁移的新项目可据快照建立初始迁移。
- 使用独立 `wrangler.local.jsonc` 和明确的 `--local` 验证迁移；本地占位数据库 ID 必须标注，绝不写成远端真实 ID。检查表、索引、约束及 `PRAGMA foreign_key_check`。
- API 未实现不阻塞存储配置，也不扩大范围去实现业务代码；上传、假模型及状态机联调明确记为未验证。

### 2. 自动发起网页鉴权

- 使用项目内 Wrangler 执行 `whoami`，核对邮箱、账号及权限；凭据有效且后续查询成功时跳过登录。不要读取或输出 OAuth 凭据文件。
- 未登录、凭据失效或 D1/R2 查询返回认证错误时，先用该版本的 `login --help`、`login --scopes-list` 核对支持的选项，再由代理执行登录并自动打开浏览器。无需用户复制命令，也不要仅凭 Wrangler 的全产品缺失权限警告申请全部权限。
- D1/R2 配置使用已核实支持的 OAuth scopes：

  ```bash
  npx wrangler login --scopes user:read account:read d1:write workers:write
  ```

  执行前说明 `d1:write` 可管理 D1，`workers:write` 是较宽的 Workers 权限，并非 R2 专用权限；登录会更新本机 Wrangler 凭据。浏览器批准作为此次 OAuth 授权确认。若用户不接受此范围，停下并提供限定目标账号的 D1/R2 专用 API Token 方案，不要求用户把秘密发到聊天。
- 输出“⏳ 等待：请在浏览器完成 Cloudflare 授权”。让登录进程等待回调；如需后台执行，使用工具完成通知，不反复轮询。回调成功后自动继续，不再要求用户回复“已登录”。
- 无法自动打开浏览器时才提供授权链接；回调不可用时按该版本支持的 device flow 降级。超时或拒绝时明确报告，不无限重试。登录后再次核对目标身份。

### 3. 核对并创建远端资源

- 先用 `d1 list`、`r2 bucket list` 查重，并明确目标 Account ID。空列表且命令成功才表示没有资源；认证错误不能当成空列表。
- 只创建缺失的开发资源。同名资源仅在账号、环境和用途可确认时复用；歧义时停下，不覆盖。每次创建成功后立即记录真实 ID/桶名；中途失败保留已创建资源，重跑重新查重，不自动删除回滚。
- R2 已开通时继续；尚未开通或需添加支付方式、升级套餐时，说明计费影响并暂停让用户在网页确认，不自动开通收费服务。后续使用仍可能超过免费额度，不承诺永久免费。
- 创建命令使用上述确定的名称：`d1 create <db>`、`r2 bucket create <bucket>`。保持 R2 私有，不启用公开开发 URL、公开自定义域、清理规则或无请求的 S3 凭据。

### 4. 写入绑定并自动初始化开发库

- 在 Wrangler 的 `env.dev` 中写入真实 `account_id`、D1 ID、桶名及 `DB`/`PHOTOS`/`COMICS` bindings。本地和远端配置分开；所有远端迁移命令明确携带 `--env dev --remote`，不依赖隐式默认环境。
- 先执行 `d1 migrations list <db> --env dev --remote`，查询远端现有表定义并与迁移比较。注意迁移列表命令可能初始化迁移管理表，不将其描述为严格只读。
- 对本次新建或已核实为空的开发库，若待迁移仅包含本地验证过的安全初始迁移，自动执行 `d1 migrations apply <db> --env dev --remote`，不再逐步索要确认。创建开发资源的请求包含此安全初始化步骤。
- 已有业务表、历史迁移不匹配、待迁移含未审核变更或破坏性操作时暂停，展示差异并取得明确授权；不得把模板作为修复现网 schema 的覆盖脚本。生产迁移必须另行授权。
- 本次仅 D1/R2 时不创建 Queues、消费者或 VPS 凭据。明确包含 Queues 时再配置生产者；明确包含 VPS HTTP pull 开通时，按该版本支持的 `queues consumer http add <queue>` 执行。

### 5. 验证与报告

- 查询远端表定义，核对业务表、显式索引、唯一/CHECK/外键约束；执行 `PRAGMA foreign_key_check`，再次列迁移确认没有遗漏。空库检查通过不等于业务约束拒绝测试或上传联调通过。
- 对两个桶分别执行 `r2 bucket dev-url get <bucket>` 和 `r2 bucket domain list <bucket>`，确认公开开发 URL 关闭且无公开自定义域；仅凭创建成功不能宣称私有性已验证。意外公开或已有域用途不明时暂停，不擅自修改既有访问配置。
- 检查本地配置指向正确账号和环境。只写 bindings 不代表 Worker 已部署或运行时访问已验证。
- 仅获准部署且接口已实现时，才用假模型和授权测试图验证上传、幂等重传、无权限请求、VPS pull/ack 及成品下载。真实模型调用另行授权。
- 每个有意义步骤输出状态；最后列实际资源、环境、迁移和检查结果，明确失败/跳过/未验证项。用 ✅ 完成、⚠️ 部分完成或 🔴 阻塞作为最后一行，不输出秘密、签名 URL 或照片内容。不要提交或推送，除非用户要求。

## 不变规则

- 部署与运行身份分离；客户端无 Cloudflare/S3/OpenAI 管理密钥；秘密只进 Secret 或 VPS 凭据存储，不进 Git、日志和聊天。
- 图片对象写入成功后才可标记上传或任务完成；漫画 Queue 仅放 `job_id`；image2txt Queue 仅放 `photo_id` 和 `analysis_version`，均不传照片、对象键或秘密。R2 和 D1 不承诺跨服务事务，按参考文档处理故障恢复。
- 不改现有线上 Worker、网络、防火墙，不自动升级套餐，不自动执行清桶或破坏性迁移。自动化不绕过权限拒绝和必要的安全确认。
