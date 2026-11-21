# LookMe 图片转文字 Queue Worker

独立入口 `src/index.ts` 只导出 `queue()`，无 `fetch()`；所有 Wrangler 环境关闭 workers.dev、预览 URL 和 HTTP 路由。共用上传 Worker 的 D1 `DB` 和私有 R2 `PHOTOS`，通过原生 Workers AI binding `AI` 调用 **`@cf/google/gemma-4-26b-a4b-it`**。

已于 **2026-11-21** 将 Gemma v2 发布至 `lookme-image2txt-dev`，当前版本 `65c52d73-67bf-4f01-9f9d-6f2fa00b077b`，已核对新版本100%活动且绑定 AI/DB/PHOTOS。**真实合成图已完成 Queue → Gemma → D1 → ack 验收**。不再调用 Moondream，也不需要 `MOONDREAM_API_KEY`；不能把旧部署或 mock 成功当作真实 Gemma 验收。

## 本次真实验收（2026-11-21）

- dev Worker：`lookme-image2txt-dev`；实际活动版本：`65c52d73-67bf-4f01-9f9d-6f2fa00b077b`。
- 合成图：256×160 JPEG、5,129字节，白底红色方块和蓝色圆形；未使用真实私有照片。
- `photo_id: b4cc3189-c26c-49f7-aa3f-4652e6111f36`、`analysis_version: v2`；D1 状态 `succeeded`、领取次数1，日志 `message_ack / analysis_succeeded`。
- 平台实际 invocation 指标：**CPU 13 ms，wall time 1,540 ms，outcome ok**；应用模型阶段 wall time 1,098 ms。不是 Startup Time，也不是本地 mock 数据。
- 13 ms 高于用户提出的10 ms目标，但此次平台未终止任务；不能据此保证严格10 ms预算、其他触发器或最大尺寸图片可用，也不能仅凭一次样本断言必须/无需升级。未升级套餐。
- 对同一 photo/v2 复投后，日志为 `already_succeeded`，没有 `call_provider` 阶段；D1 attempt_count仍为1，调用标记、request ID及文字均未变化。重复投递实测CPU 7 ms、wall time 119 ms。
- 新 Worker 本地62项测试、上传 Worker18项回归、类型检查与dry-run构建均通过；远端foreign_key_check为空，AI/DB/PHOTOS、Queue/DLQ及持久化调用日志已核对。

实际模型文字：

> 这张图片在白色背景上展示了两个几何图形：左侧是一个红色的正方形，右侧是一个蓝色的圆形。图中没有可见的动作或场景。

这些是本次特定合成图的验收记录，不是跨账号复现时应复制的资源ID，也不是后续真实模型调用的授权。

## 消息与处理链路

发送 Queue JSON 对象，不是二次编码字符串：

```json
{
  "photo_id": "00000000-0000-4000-8000-000000000001",
  "analysis_version": "v2"
}
```

1. 严格校验两个字段，UUID 大小写归一化；不接受 owner、object_key、URL、凭据或模型参数。
2. 按 photo_id 查询 D1，取得可信 object_key，从私有 PHOTOS 读取图片。
3. 检查大小（≤ 2 MiB）、实际字节数和 SHA-256；不重新解码/重编码 JPEG，不修改原始照片元数据。
4. 原子领取并在调用前持久化提交标记，经 `env.AI.run()` 分析图片。
5. 只有完整文字成功写入 `photo_analyses` 后才确认消息。

生产者属于可信服务端边界，不是用户授权 API。上传 Worker 目前不会自动投递分析消息，本次不新增公开查询/下载接口或漫画生成 API。

### 版本隔离

- `v1` 固定为历史 Moondream 语义，**不改为 Gemma 的别名**。现有 v1 数据保留；本消费者拒绝旧 v1 消息并让其进入 DLQ，不重新调用 Moondream。
- `v2` 固定使用 Gemma 模型、简体中文事实描述 prompt、`max_completion_tokens: 512`、`chat_template_kwargs.enable_thinking: false`、`stream: false`。
- 唯一键仍为 `(photo_id, analysis_version)`。已有同版本记录的 model 不匹配时不领取、不覆盖、不调用，输出 `analysis_model_mismatch`。
- 后续改变模型/提示词/生成参数，需新增分析版本，不能静默覆盖历史结果。当前结构已支持新版本，不需要为 v2 另加数据库迁移。

## 原生 Workers AI 调用

配置使用 `"ai": { "binding": "AI" }`，运行时 `env.AI.run(MODEL, input, options)`；不读取外部厂商 API Key，也不把 Cloudflare 管理 Token 注入 Worker。

- 多模态 `messages` 包含图片 `image_url` 和中文描述指令，仅描述图中可见事实。
- 图片仍使用 `data:image/jpeg;base64,...`。**原生 binding 不代表模型接受原始 JPEG 请求体**；本次不公开 R2、不创建签名 URL 服务。
- `returnRawResponse: true` 用于有界读取响应（最多 128 KiB），超时覆盖推理与正文读取（45 秒），`AbortSignal` 传给 AI binding。
- 按 Gemma 官方 OpenAI 兼容输出读取 `choices[0].message.content`，要求单条 choice、`finish_reason: stop`、非空文字且最多 16,000 个 JavaScript 字符。截断、过滤或工具调用结束不保存为成功。
- 可用的输出 `id` 保存为 `provider_request_id`。模型文字是不可信数据，不执行其中的指令。
- 不启用 AI Gateway 自动重试或回退其他模型。请求错误、超时、未知结果不能据此断言没计费。
- 实际发送的是已上传的原始图片字节，可能带 EXIF；只允许使用已授权照片，真实验收默认合成小图。

官方参考：[Gemma 模型](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)、[输入 schema](https://developers.cloudflare.com/ai/models/%40cf/google/gemma-4-26b-a4b-it/sync-input.json)、[输出 schema](https://developers.cloudflare.com/ai/models/%40cf/google/gemma-4-26b-a4b-it/sync-output.json)。

## 状态机、重试与 DLQ

迁移唯一来源为 `../worker-upload/migrations/0003_photo_analyses.sql`，两个 Worker 维护同一目录。分析表外键引用照片，禁止删除仍被引用的照片，原始元数据不覆盖。

| 状态 | 行为 |
| --- | --- |
| queued | 记录已建立，尚未领取 |
| running | D1 条件更新领取，lease 120 秒；并发重复消息等待，不提前 ack |
| retry_wait | 调用前可恢复错误，按 D1 中的时间退避后重试 |
| succeeded | 完整文字已落库；本条和后续重复消息可以 ack |
| needs_review | 可能已调用/计费但结果未知，禁止自动重调 |
| failed | 准备阶段永久错误或次数耗尽，不再调用模型 |

- 准备阶段最多领取 5 次，重试延迟 60、120、240、480、900 秒。缺 AI binding、缺图、R2 读取故障可重试；大小/hash 不符为永久失败。
- 调用前以 lease token 条件写入 `provider_attempt_id` / `provider_submitted_at_ms` 并续期；只有该写入的成功响应才能放行模型调用。
- 调用标记不等于供应商幂等键，也不能证明请求已到达。标记已写但发送前崩溃，同样可能需要人工核查。
- 超时、HTTP/绑定异常、无效/不完整响应进入 needs_review，不自动清除提交标记或重复推理。
- D1 保存响应丢失时，可能已经提交；条件更新不覆盖 succeeded。重投只读成功结果并确认，不能重新生成文字。
- 无提交标记的过期 lease 可重领；已有标记的过期 lease 转 needs_review。同一调用的迟到成功仍可落库，旧领取者不能覆盖新领取者。
- `lookme-dev-image2txt` 每批 1 条、并发最多 2，默认延迟 60 秒，`max_retries: 8`（初投之外的重试次数），耗尽后进入 `lookme-dev-image2txt-dlq`。
- 除 succeeded 外都 retry；非法消息/不存在的照片无法创建合法分析行，原消息直接经 Queue 有限重试至 DLQ。
- 不自动消费或重放 DLQ。已核实 dev 两个队列保留期为 24 小时；DLQ 不是永久备份，需在期限内检查和处理。

这是保守抑制重复调用的策略，不是 D1 和模型服务之间的 exactly-once 事务。对 needs_review，先用 photo/version、提交时间、attempt/request ID 核对平台结果，再由管理员决定补结果或另行授权新调用。

## 日志与 Free Plan CPU 诊断

`dev` 配置 Workers Logs 全采样，开启持久化 invocation logs。结构化日志包括：

- `message_start`、`stage_start` / `stage_end`：D1 读取/领取、AI binding 检查、R2 读取、hash、Base64、提交标记、模型调用、结果落库。
- `operation_failed`：失败阶段和固定错误代码；`provider_timeout` 是应用 45 秒超时，不等于平台 CPU 超限。
- `message_ack` / `message_retry`：确认或重试的原因、状态和延迟。主动 retry 后平台 outcome 仍可能是 ok，要同时看应用事件。
- `photo_id` / version、Queue message ID、投递次数、图片字节数和结果字符数。不记录图片、对象键、文字正文、凭据或底层异常内容。
- `elapsed_wall_ms` / `stage_wall_ms` 是应用时钟观测的实际经过时间，**不是 CPU 时间**。Workers 时钟在同步计算期间可能不前进，不能凭 0 ms 推断编码不消耗 CPU。

模型推理发生在 Workers AI，不占用等量 Worker CPU；但 Base64/JSON、校验和日志仍消耗 Worker 资源。Free 配额及不同触发器限制应核对 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 和 [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)。本实现不修改 cpu_ms，不自动升级套餐；Workers AI 推理额度/计费与 Worker CPU 限制分别核对。

CPU/内存强制终止不保证执行 catch/finally 或输出最后日志。最后的 stage_start 仅帮助定位，需结合平台 CPU time、wall time、Metrics 的 `Exceeded CPU Time Limits` 和 `exceededCpu` outcome。小图成功不证明 2 MiB/2048px 图片能稳定通过 Free CPU 预算。

在 Cloudflare 的 Worker → Observability 查看，或从本目录运行：

```bash
npx wrangler tail --env dev --format json
```

Free Workers Logs 当前文档额度为每天 200,000 条、保留 3 天，以账号实际限制为准；日志有开销，不把缺失 CPU 字段解释为 0 ms。

## 本地验证与复现

```bash
npm ci
npm run typecheck
npm test
npm run build  # --env dev --dry-run，不发布
```

Vitest 使用临时真实 D1/R2、mock `AI.run`，以及真实本地 Queue/DLQ。运行时测试入口 `test/queue-fixture.ts` 只在测试中替换 AI binding，通过本地 service binding 返回 OpenAI 兼容 mock；禁止任何真实外部调用，不会读取账号凭据或消耗推理额度。覆盖版本隔离、重复投递、抢占、超时、截断、存储提交前后故障及 schema 一致性。

`wrangler.local.jsonc` 的 AI 声明不是本地 GPU 模型。**不要把 wrangler dev 当作离线 mock**：AI binding 的真实推理可能访问远端并消耗额度，必须另行授权；离线验证用 npm test。本地 Wrangler 状态也不会自动与上传目录共享。

部署步骤与授权边界见 [部署 SKILL](../../skills/deploy_worker/references/image2txt.md)。重跑复用资源和同一测试 photo/version；不清除调用标记、不为了测试重复计费、不删除历史 Secret 或资源。
