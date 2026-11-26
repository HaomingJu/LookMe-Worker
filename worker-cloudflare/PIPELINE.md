# 自动图片分析管道

## 原则与配置来源

**通过版本管理的配置、脚本和测试复现，不依赖 AI 每次重新决定步骤。**

所有 Cloudflare 配置变更均来自两个项目的 `wrangler.jsonc` / `wrangler.local.jsonc`，通过锁定版本 Wrangler 应用。不通过控制台或管理 API 改绑定、Cron、队列触发器、参数、路由或日志。

D1 schema 无法直接写在 Wrangler JSONC 中：使用 `worker-upload/migrations/0004_photo_analysis_dispatch.sql`，通过 Wrangler migrations 执行。初次创建 D1/R2/Queue 资源也不是这些文件自动完成的；脚本要求本项目资源已经存在，缺失时停止并提醒，不能把权限错误当成缺失并创建资源。配置的当前 Account ID/数据库 ID 是当前环境记录，跨账号必须先重新确认并填写。

| 文件 | 唯一职责 |
| --- | --- |
| `config/analysis-profiles.json` | 默认新任务版本、每版本的模型、提示词、token上限、thinking开关 |
| `config/analysis-profiles.schema.json` | 编辑器可用的字段/类型/范围约束 |
| `config/analysis-profiles.lock.json` | 各版本参数指纹及退役版本，不手改已有hash |
| `worker-upload/wrangler*.jsonc` | Queue生产者、Cron、Outbox参数、DB/R2、原有HTTP路由、日志 |
| `worker-image2txt/wrangler*.jsonc` | Queue消费者/DLQ、并发/重试、AI/DB/R2、关闭HTTP、日志 |
| `worker-upload/migrations/` | 共享数据库的版本化变更，不在其他目录复制 |
| `scripts/pipeline.mjs` | 固定校验、预览、部署顺序；远端配置修改只调用Wrangler |

## 执行入口

首次准备依赖，从仓库根目录运行（不是npm workspace）：

```bash
npm --prefix worker-cloudflare/worker-upload ci
npm --prefix worker-cloudflare/worker-image2txt ci
```

从仓库根目录，固定使用：

```bash
# 均离线：校验参数/版本锁/两个Worker的连接，或展示目标及完整步骤
node worker-cloudflare/scripts/pipeline.mjs check
node worker-cloudflare/scripts/pipeline.mjs plan

# 确认plan中的账号、域名、迁移和真实推理影响之后，才执行远端修改
node worker-cloudflare/scripts/pipeline.mjs deploy-dev --confirm-dev
```

也可从任一 Worker 目录使用：

```bash
npm run config:check
npm run pipeline:plan
npm run pipeline:deploy:dev -- --confirm-dev
```

部署脚本会：

1. 使用**锁定 Wrangler 的官方解析器**解析 JSONC，检查DB/R2一致、生产/消费队列同名、DLQ不同名、Cron、参数范围及AI版本锁；禁止分析Worker开放HTTP。
2. 执行两个项目的typecheck、全部mock测试及dry-run构建。`npm run build`自身也会先检查配置；不会自动升级依赖。
3. 固定使用配置中的目标Account ID；检查登录、已有两个Worker、输入Queue/DLQ。失败即停，不自动申请全权限、创建资源或升级计划。
4. Wrangler列出/应用缺失迁移（`--env dev --remote`）。应用0004只建Outbox表和索引，**不回填任何历史照片**。
5. 先发布消费者，再发布上传生产者及Cron；两者均 `--env dev`，保留配置中的原有上传域名，不增加其他路由。
6. 列版本、队列连接、迁移和外键结果。脚本不会上传测试图，不会补投历史照片，也不会直接调用模型；启用后新的正常上传会自动产生分析任务。

`--confirm-dev` 是对展示的配置和操作的明确确认；没有该参数只展示步骤然后停止。任何步骤失败均保留已完成状态，不自动回滚/删除资源。重跑复用现有队列、迁移及Outbox；Wrangler可能创建新的部署版本，但不会为旧照片重新建任务。跨账号首次资源初始化、路由迁移、历史补投及付费升级不在此脚本范围。

## 上传和Outbox行为

```text
认证与图片校验
  → R2保存图片
  → D1同一batch事务：photos + photo_analysis_dispatch
  → 返回上传结果，waitUntil尝试入队
  → Queue消费：读取可信图片 → AI → 分析结果落库 → ack
```

- Queue或投递标记临时失败，不把已成功保存的照片返回为上传失败；Outbox保留任务等待补投。
- 事务中任一INSERT失败，照片和Outbox一起回滚。R2仍无跨服务事务，可能留下孤儿对象，保持原有“不盲删”策略。
- 同用户相同client_photo_id重传只复用现有照片，补投**已有**Outbox；不会为旧照片或新的默认版本额外建任务。不同用户隔离不变。
- Outbox主键 `(photo_id, analysis_version)`，`published_at_ms`仅表示Queue已接收，不表示分析成功。
- 原子领取带lease，防止即时发送与Cron竞争；进程中断可在lease过期后恢复。接收/落库响应不确定时允许同一消息重复投递，由消费者幂等抑制重复推理。
- Cron只处理Outbox，**不会扫描photos表自动给历史照片建任务**。没有Outbox的历史照片不会因为部署而开始推理。
- Outbox外键使用RESTRICT：仍有投递记录的照片不能直接删除，需要后续明确的数据清理流程。

## Outbox运行参数

在上传 Worker 的 `env.dev.vars` 修改，部署后生效；本地对应 `wrangler.local.jsonc`。

| 字段 | 当前值 | 含义 |
| --- | ---: | --- |
| `PHOTO_ANALYSIS_ENABLED` | `true` | 是否为新上传创建分析任务，并运行即时/Cron投递 |
| `OUTBOX_BATCH_SIZE` | `10` | 每次最多领取的记录数；范围1–100 |
| `OUTBOX_LEASE_SECONDS` | `60` | 投递租约；范围30–900秒 |
| `OUTBOX_RETRY_BASE_SECONDS` | `60` | 首次失败退避；后续指数增加 |
| `OUTBOX_RETRY_MAX_SECONDS` | `3600` | 失败退避上限；持续故障保留待投记录，不丢弃 |

Cron由 `triggers.crons` 配置，当前 `* * * * *`，UTC每分钟运行一次，每次只处理一个有界批次。Cloudflare Cron配置传播可能延迟，不能把部署后第一次未触发立即当成配置失败。

**关闭开关的语义**：停止创建新任务，也暂停已有Outbox投递；关闭期间上传的照片不会在重新开启时自动补建任务。已经入Queue的消息仍由消费者处理，开关不取消已排队或在途推理。

消费者的并发、重试上限、DLQ在消费者Wrangler文件中调整。死信、needs_review不自动重放或清除调用标记；不要为“恢复”而盲目重复收费。

## 更换AI配置

当前默认版本v2沿用已验证的Gemma语义。只支持 `workers-ai-chat` 适配器的多模态Chat Completions协议；配置不能自动让任意模型兼容该协议。

正确变更顺序：

1. 在 `analysis-profiles.json` 中**保留v2**，新增v3，填写模型、prompt和参数。不接受未知字段或以字符串代替布尔/数字。
2. 新版本参数确定后，从任一 Worker 目录运行：

   ```bash
   npm run profiles:lock
   ```

   只追加新版本的SHA-256指纹；修改或删除已有版本会被拒绝，已退役v1也不能重定义。
3. 将 `default_version` 改为需要用于**新上传**的版本。已有Outbox仍保留原版本，不被重解释。
4. `config:check`、`pipeline:plan`，确认后按固定部署入口发布。先消费者后生产者，避免新消息进入不认识该版本的消费者。
5. 进行已授权的合成图验收；不要把mock通过当成模型真实可用性证明。不同模型接口/参数支持与额度仍需官方确认，不自动回退其他模型。

共享运行时也会懒校验指纹，不只是CLI检查；配置不一致时停止处理，不静默退回默认模型。JSON和lock需一起提交。提示词、模型或生成参数变化都使用新版本；不要通过改旧hash绕过语义约束。

## 观察与诊断

- 上传端日志：`photo-outbox / dispatch_accepted`、`dispatch_retry_scheduled`、`dispatch_deferred`，只记录固定代码及数量，不记录凭据/图片。
- 消费端日志：各阶段、`message_ack` / `message_retry`、固定错误码，不把wall_ms当CPU时间。
- 查看数据库（从上传目录执行，只读）：

  ```bash
  npx wrangler d1 execute lookme-dev --env dev --remote --command "SELECT COUNT(*) AS pending FROM photo_analysis_dispatch WHERE published_at_ms IS NULL; SELECT analysis_version,status,COUNT(*) AS count FROM photo_analyses GROUP BY analysis_version,status;" --json
  npx wrangler tail --env dev --format json
  ```

  分析Worker的tail命令需从其目录执行。当前 JSON 模式不打印 Connected 提示，不能据此判断未连接。
- 待投持续增加时检查Cron、Queue配额、绑定和D1错误；Outbox已published但无成功文字时检查消费者/DLQ/needs_review。
- 自动分析会消耗Workers AI及Queue/D1额度，不自动升级套餐。原有一次小图CPU13ms/outcome ok的验收不能证明所有图片满足严格10ms。

## 测试与授权验收

`npm test`均离线，无真实凭据或付费模型：
- 真实本地D1事务：Outbox失败回滚照片、并发上传、D1已提交但响应丢失。
- Queue失败、批次上限、退避、lease过期、旧lease写入保护、标记响应丢失。
- 本地真实HTTP上传 → 首次发送失败 → scheduled补投 → Queue → mock AI → D1成功；重传不重复分析。
- 配置锁、追加新版本、拒绝篡改旧版本、Wrangler连接关系及部署确认开关。

远端验收使用单独授权的合成图/测试身份，正常通过上传API验证自动链路；不要手工向Queue投消息来替代“上传自动入队”的验证。若要验证Cron，可在受控测试范围通过Wrangler SQL安排一条明确的待投Outbox，不批量处理真实历史照片。保留验收检查点，不自动删除数据或旋转用户Token。

## 明确授权后的历史补跑

照片按 `owner_id` 归属，不按Token分成独立副本。同一用户的多个Token共享同一组照片；按多个Token补跑时，先查Token到用户的对应关系并对用户去重，再逐用户预览/补跑，不要把同一组照片重复计数或重复分析。查询归属只需token_id/user_id，不读取凭据明文或哈希；验收用的临时Token与业务Token分开核对。

补跑是数据操作，仍通过Wrangler D1执行，**不会修改Cloudflare配置**，也不直接调用模型。它只为指定owner目录下、没有该版本Outbox且没有任何该版本分析记录的照片新增Outbox；已成功、running、failed或needs_review均不重建，更不会清除提交标记。

从仓库根目录，先只读预览，再明确确认：

```bash
node worker-cloudflare/scripts/pipeline.mjs backfill --owner OWNER --version v2 --max-photos 14
node worker-cloudflare/scripts/pipeline.mjs backfill --owner OWNER --version v2 --max-photos 14 --confirm-model-calls
```

owner 可为用户名或 UUID；目录固定为`photos/v1/{user_id}/`（用户名会先解析为 user_id），版本必须存在且通过锁校验，上限1–100。符合条件的数量超过上限时**全部拒绝**，不会悄悄挑选前N张。写入时再次检查状态，写入响应不确定后重跑也不会重复创建任务。新记录由已有Cron和Queue处理，会消耗真实推理额度；这是独立于部署命令的明确操作，不因部署而自动运行。

## 2026-11-21 dev应用与验收记录

- 上传Worker `lookme-api-dev`：`5e15d8a8-f03e-4326-b9c4-c0a22155a91a`。
- 分析Worker `lookme-image2txt-dev`：`21c1d21a-3be8-40dc-ace9-a2c7b5f57b64`。
- 保留上传域名 `api.fudaixuexue.eu.cc`；workers.dev/预览入口显式关闭，消费者无HTTP路由。
- `0004`已应用，外键检查为空；Queue确认1个生产者、1个消费者，Cron为每分钟。
- 固定部署入口已成功执行两次，第二次没有待应用迁移、没有重复处理历史图片；部署本身不调用AI。
- 真实新上传：201 → Outbox → Queue → Gemma → D1 succeeded；同请求重传200，复用同一photo_id，投递/分析次数仍为1。
- 用户明确授权的既有14张：14条Outbox、14条succeeded、14份非空文字，最大投递/分析次数均为1。Cron分批投递的进度先为10张成功、4张待投，最终全部完成。再次补跑预览候选为0。
- 验收时Outbox待投数量为0。本地51项上传/管道测试、74项消费者/配置测试以及两边类型检查/dry-run构建全部通过。
- 本次Wrangler实时tail未成功连接，未取得新CPU采样；持久化调用日志配置保持开启。历史单图CPU13ms不能冒充此次125项本地测试或14张批处理的CPU数据。

该记录仅是当次验收证据，不是后续历史补跑或付费调用的授权。合成数据和受限检查点保留，未自动删除用户、照片、Token或结果。
