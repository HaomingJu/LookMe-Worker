# D1、R2 与凭据设计

## 资源与鉴权

开发和正式环境各用独立资源，不共享运行凭据。下表是开发命名建议，不是已存在的资源。

| 资源 | 开发名 / 绑定 | 运行身份 |
| --- | --- | --- |
| D1 | `lookme-dev` / `DB` | API Worker 直接使用 binding 及参数化语句；VPS 只调用经业务鉴权的内部 API |
| 输入 R2 | `lookme-dev-photos` / `PHOTOS` | API 写入；VPS 专用 S3 Object Read Only，仅此桶 |
| 成品 R2 | `lookme-dev-comics` / `COMICS` | VPS 专用 S3 Object Read & Write，仅此桶；API 读取并鉴权下载 |
| Queues | `lookme-dev-comic-jobs` / `COMIC_QUEUE` | API 走生产者绑定；VPS 使用指定账号的 Queues Read + Write 令牌做 pull/ack |
| OpenAI | 独立 LookMe Project | 服务账户 key 只存 VPS，创建后配置 Restricted 权限并验证实际 Images 端点；不用组织管理密钥 |

- 部署身份独立管理创建、部署和迁移；账号范围最小化。R2 S3 key 不是 Cloudflare 管理令牌。不要把成品桶权限描述成 write-only；Object Read & Write 也可读。Queues 权限以官方文档的账号粒度为准，不承诺限制到单个队列。
- CLI 的 Demo bearer 和 VPS 内部调用 bearer 分开。内部 API 只提供任务领取、模型提交标记和状态回报，不暴露任意 SQL；以任务租约校验写操作。用户归属从鉴权结果解析，不信任请求正文里的 owner。
- 实际密钥放 Cloudflare Worker Secret 或 VPS 受限的服务凭据存储；示例配置只写变量名。记录负责人和轮换日期，不记密钥值；先部署新密钥、验证后撤销旧密钥。给真实模型设置应用侧生成上限，不能把预算提醒当成熔断。
- Wrangler 建议检查 `d1_databases`、`r2_buckets`、`queues.producers` 对应环境下的真实值。空白环境可使用 `wrangler d1 create <name>` 和 `wrangler r2 bucket create <bucket>`；先核对账号及资源列表。R2 禁用公开开发 URL 和公开自定义域。

## D1

[当前完整结构快照](schema.sql)（版本化迁移为 `0001_initial.sql` + `0002_user_tokens.sql` + `0003_photo_analyses.sql`）：

- `users` / `user_tokens`：独立用户及凭据哈希；Token 由受控 CLI 随机签发，明文仅存受限文件。请求从未撤销、未过期凭据及 active 用户解析 owner；旧共享 Worker Token 不再使用。历史 owner 补建用户但不自动签发凭据。详见 [部署 Skill](../../deploy_worker/SKILL.md)。

- `photos`：保存对象位置、SHA-256、图像尺寸、拍摄时间来源与上传时间；每个 owner 下的 `client_photo_id` 唯一。拍摄时间未知就留空，不使用上传时间代替。
- `photo_analyses`：独立 image2txt Queue 消费者的状态/文字结果，以 `(photo_id, analysis_version)` 唯一。调用前持久化提交标记；不确定结果进入 needs_review，禁止自动重调。原始照片元数据不覆盖，详细部署/日志边界见 `../../deploy_worker/references/image2txt.md`。
- `comic_jobs`：记录状态、幂等键、请求摘要、服务端固定的提示词版本和生成参数快照、租约、模型提交标记和成品路径。查询必须带 owner 条件。
- `comic_job_photos`：按 `position` 记录输入顺序，复合外键保证任务和照片归属一致。Demo 要求恰好 3 张不同照片，API 在原子建单操作中检查；外键和位置约束不能代替数量校验。
- `job_dispatch`：在同一个 D1 batch 中写入任务、输入关联与待投递行。事务完成后发队列；发出但写回标记失败可能重复发，不应导致重复推理。恢复任务只补投未发布且到期的行。

VPS 收消息时通过内部 API 原子领取任务，拿到不可预测的租约令牌。配置队列可见期覆盖完整有界处理时长（含持久化和 ack）；状态变更必须检查当前令牌与有效期。发出模型请求前持久化提交标记与尝试标识（可用当次租约令牌，保留到该尝试完成或转人工确认），并关闭 SDK 自动重试。租约过期若发现已提交但无可核验成品，不重调模型，进入 `needs_review`；若能根据已持久化的尝试标识核验同一任务的合法成品，则恢复状态。已确认可重试的错误才按上限和退避重试。落 R2 并确认 D1 状态成功后才 ack。

## R2 对象布局

| 桶 | 对象键 | 说明 |
| --- | --- | --- |
| 输入 | `photos/v1/{opaque_owner}/{photo_id}/{sha256}.jpg` | 服务端生成，不用原始文件名，按不可变内容保存 |
| 成品 | `comics/v1/{opaque_owner}/{job_id}/{attempt_id}.png` | 每次尝试独立，D1 选择发布对象，避免旧租约覆盖新结果 |

用户身份使用内部不透明 ID，不在键名、元数据中放邮箱、GPS 或原路径。R2 写 `Content-Type`；业务元数据以 D1 为准。先写 R2 再写/确认 D1：同一个幂等键重传时仅复用内容摘要与关键元数据相同的记录，否则返回冲突；并发失败分支可能产生孤儿对象，按审计列表和宽限期清理，不在上传失败时盲删可能已被引用的对象。

Demo 开发环境可先定输入和未引用成品保留窗口，例如 7 天；正式启用删除前确认政策，并由应用按 D1 判断活跃任务/可下载成品是否仍引用该对象。不要直接对整个桶开启会误删已发布内容的规则。结果经过 API 鉴权，从 R2 binding 流式返回，不发公开桶 URL；以后若改直传，R2 binding 本身不签发 S3 预签名 URL。

官方参考：[D1 Wrangler](https://developers.cloudflare.com/d1/wrangler-commands/) · [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) · [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/) · [R2 预签名](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [Queues pull](https://developers.cloudflare.com/queues/configuration/pull-consumers/) · [OpenAI Projects](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)
