# 每日故事 Worker

独立的手动 HTTP Worker：从已有 `photos` / `photo_analyses` 读取某个用户一天的图片摘要，通过原生 Workers AI `@cf/qwen/qwen3.8-27b` 整理成 **N 个故事、每故事四格分镜及生图提示词**，直接返回 JSON。只接受摘要文字，不读取 R2、不生成图片、不写 D1；不新建表、不改变现有上传/分析管道，没有 Queue 或 Cron。

## 目录与共享依赖

| 入口 | 用途 |
|---|---|
| [`src/index.ts`](src/index.ts) | `POST /stories`、用户鉴权、参数检查及响应 |
| [`src/input.ts`](src/input.ts) | 按北京时间上传日读取指定用户的全部摘要 |
| [`src/model.ts`](src/model.ts) / [`src/output.ts`](src/output.ts) | 单次 Qwen 调用、N 个故事与四格来源校验 |
| [`scripts/story.mjs`](scripts/story.mjs) | 手动触发并输出或保存故事 JSON |
| [`config/story-profiles.json`](config/story-profiles.json) | 固定模型、提示词、输出 Schema、版本和资源上限 |
| [`scripts/config.mjs`](scripts/config.mjs) | 离线配置检查与仅追加版本的指纹锁维护 |

这是独立 npm 项目，但应从**完整仓库**检出，不要只复制 `worker-story/`：它复用 [`../shared/analysis-config.ts`](../shared/analysis-config.ts)、[`../config/`](../config/)、[`../worker-image2txt/src/bytes.ts`](../worker-image2txt/src/bytes.ts)，并读取上传端的 Wrangler 配置与共用迁移。运行本项目仅需在本目录安装依赖，不需要安装或启动其他 Worker。

故事生成依赖已有的成功图片分析结果；本项目不负责补跑图片分析。代码检查、本地测试、部署、真实模型调用是四个独立步骤，前两者不会授权后两者。

## 本地检查

在本目录执行：

```bash
npm ci
npm run config:check
npm run typecheck
npm test
npm run build
npm run story -- --help
```

`build` 只是 Wrangler dry-run。测试使用临时真实 D1、合成摘要和 mock AI，阻止公网访问；既不读取现有用户照片，也不调用真实模型。贯通测试从手动脚本经真实本地 HTTP 调用 workerd，在临时 D1 中读取摘要，通过测试夹具注入 mock AI，验证完整故事返回及0600文件保存；另有业务与故障注入测试。

`wrangler.local.jsonc` 没有 AI binding，且生成开关为 false：Workers AI 并不会本地推理，不能因为运行 `wrangler dev` 就静默调用远端模型。其独立本地 D1 不会自动共享上传 Worker 的 `.wrangler` 状态。`npm run db:migrate:local` 仅给本 Worker 的本地开发库应用共用迁移；完整可运行示例以 `npm test` 为准。

### 本地验收记录（2026-11-21）

- 配置指纹、D1 连接配置和手动触发边界检查通过。
- `npm run typecheck` 通过；`npm test` 共 **72 项通过**。
- `npm run build` 的 Wrangler dry-run 打包通过，不代表已部署。
- 已覆盖脚本 → 本地 HTTP → workerd → 临时 D1 → mock AI → 0600 JSON 文件的完整链路。
- 真实 Qwen 调用、线上模型可用性、实际耗时和生成质量尚未验证；没有为这些检查上传照片或开通收费服务。

## 手动运行脚本

前提：此 Worker 已单独获准部署，配置了独立公网地址，并经 Wrangler 设置 `STORY_GENERATION_ENABLED: true`。**初始配置关闭公开入口及模型调用，仓库代码完成不代表已经上线。** 没有默认生产 URL，不会把故事请求误发给上传 API。

```bash
npm run story -- \
  --base-url 'https://你的故事Worker域名' \
  --token-file '/已有受限目录/user1.token' \
  --date 2026-11-21 \
  --stories 3 \
  --confirm-model-call
```

- 现有独立用户 Token 即可，不需要 Cloudflare 管理凭据。Token 文件需归当前用户、权限 0600；不要传 Token 明文或 `owner_id`。
- `--date` 为北京时间的**上传日期**，与现有调试页一致，不是 EXIF 拍摄日期；覆盖 `[当天00:00, 次日00:00)`。本版支持 2000–2099 年，时区及时间口径在故事版本中固定。
- `--stories N` 默认 3，支持 1–8，且不能超过照片数量。输出必须恰好 N 个故事；不擅自减少 N。
- `--story-version v1` 可选。v1 固定使用分析版本 v2（Gemma 摘要）和 Qwen 模型，不混用旧版本。
- 当前日期可以调用，但结果 `day_complete: false`，仅代表请求开始时的快照；要完整一天应在该日结束且摘要全部完成后调用。结束后的补上传不会追溯改变已经返回的故事。
- 没有任何自动触发。`--confirm-model-call` 表示本次手动请求可能产生 Workers AI 费用；重复运行会再次推理，**没有跨请求缓存/幂等登记，也不宣称收费恰好一次**。
- 只进行一次 HTTP 请求，不跟随重定向、不自动重试。服务端模型调用与读正文合计最多 90 秒，脚本等待最多 110 秒。超时、断连、取消或输出异常可能已经产生费用；应先核对情况，不自动重发。脚本只接受 HTTPS（localhost/127.0.0.1/::1 可用 HTTP）。

默认把故事 JSON 返回到终端。如果要保存，使用仓库外已存在的受限目录（0700）：

```bash
npm run story -- \
  --base-url 'https://你的故事Worker域名' \
  --token-file '/已有受限目录/user1.token' \
  --date 2026-11-21 --stories 3 --confirm-model-call \
  --out '/已有受限目录/2026-11-21.story.json'
```

`--out` 以 0600 新建，拒绝覆盖；在请求前占用输出路径，失败可能留下空文件。不要把故事、摘要、凭据或输出文件提交 Git。JSON 包含用户的生活记录，默认没有云端故事副本。

## 接口

`POST /stories`，`Authorization: Bearer <用户Token>`，`Content-Type: application/json`：

```json
{"date":"2026-11-21","story_count":3,"story_version":"v1"}
```

只允许上述字段，拒绝用户自报 owner、摘要、模型或提示词。服务端通过 Token 哈希、到期、撤销状态和 active 用户确定归属，参数化查询 D1。整日照片最多 128 张，序列化输入最多 64 KiB；超过限制会明确拒绝，**不会只用前若干张或截断摘要**。这些是保守应用上限，不是模型官方上下文上限；暂未实现多批次压缩，避免额外调用和隐藏费用。

一天内只要有任何照片的指定版本摘要未完成、失败或待核查，就返回 `409 summaries_not_ready`（含状态计数），不以部分摘要冒充全天。模型字段与固定分析版本不匹配同样拒绝。摘要只作为不可信 JSON 数据，system prompt 不执行摘要中的指令；这降低注入风险，不是事实正确性的保证。

成功 `200` 的主要字段：

```text
request_id, date, timezone, date_basis, snapshot_at, day_complete
photo_count, story_count, story_version, analysis_version, model
input_sha256, provider_request_id, usage, sources[]
daily_summary
stories[]:
  title, summary, source_photo_ids[], image_prompt
  panels[4]: panel(1–4), description, source_photo_ids[], image_prompt
```

`image_prompt` 是一张2×2四格漫画的完整生图提示词；`panels[].image_prompt` 是各分镜的独立提示词。图片 ID 仅用于来源追溯，不是公开 URL，也不会自动提交给图像模型。后续生图仍需实现、鉴权、单独授权。

所有输入照片必须恰好归属一个故事；四格合计必须覆盖各故事的来源，分镜可重复引用同一照片。故事按最早来源照片顺序排列。服务端独立校验 N、四格结构、文本长度和来源 ID，不只信任 JSON Schema；拒绝陌生 ID、漏图、重复跨故事归属和截断的模型回复。语义质量/事实忠实度仍需要人工检查，摘要无法恢复未描述的人物外观细节。

| 状态 | 含义 |
|---|---|
| 400 / 415 | 请求字段、日期、N、版本或编码错误 |
| 401 | 凭据无效、过期、撤销或用户停用 |
| 409 | 摘要未齐或固定分析版本数据不一致 |
| 413 | 请求、照片数或整日摘要超限 |
| 422 | 当日无照片或照片数不足 N |
| 502 / 504 | 模型失败、结果非法或超时，不自动重试 |
| 503 | 生成功能关闭、未配置 AI、配置锁校验失败或存储不可用 |

错误返回 `model_call_attempted`；已进入模型调用阶段的错误附带 `may_have_been_billed: true, automatic_retry: false`。没有错误响应的客户端断连同样不能认定没有收费。响应禁止缓存；日志仅含请求 ID、错误码、是否调用模型和 wall time，不含摘要、故事、Token。没有 CORS、公开注册或速率限制；部署前应评估哪些用户能使用此付费能力及预算保护。

## 可复现配置与发布边界

- `config/story-profiles.json` 固定模型、system prompt、JSON Schema、分析版本、时间口径、采样参数及资源上限；`story-profiles.lock.json` 保存递归规范化 SHA-256。
- 发布前与运行时检查指纹。`npm run profiles:lock` 只追加新版本，不能修改/删除已锁定版本。当前只实现 Qwen Chat Completions 协议、北京时间上传日和输出 revision 1；配置不是任意模型/时区的通用兼容层。
- 模型用 `reasoning_effort: low`、`stream: false`、`response_format: json_schema`、`max_completion_tokens: 12288`。这是应用预算选择，输出复杂时仍可能截断并失败；不自动增加预算或二次修复调用。
- `npm run config:check` 离线核对版本、现有上传端账号/数据库、唯一迁移来源及手动触发边界；`prebuild` 自动执行该检查。
- 所有云端配置只通过 Wrangler 文件和命令应用。**本次未部署、未启用域名、未修改远端配置，也未执行真实模型调用。** 用户另行授权部署时先读 `skills/deploy_worker/SKILL.md` 并确认公网域名；在 `wrangler.jsonc` 配置独立路由或 workers.dev、启用 `STORY_GENERATION_ENABLED`，再核对目标 Worker 后执行 `npm run deploy:dev`。该命令先检查配置、类型和测试，不会自动调用模型。
- 不把本 Worker 加入 `../scripts/pipeline.mjs deploy-dev`，不触碰已上线自动分析设置；当前无需新增迁移。

## 官方协议依据

- [Qwen3.8-27B 模型](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)
- [输入 JSON Schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/sync-input.json)
- [输出 JSON Schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/sync-output.json)

以上协议已核对；账号实际模型可用性、费用、耗时和真实生成质量需要另行授权 smoke test，不能由本地 mock 推断。
