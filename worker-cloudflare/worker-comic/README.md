# LookMe Comic Worker / LookMe 漫画 Worker

**Status / 状态:** deployed to dev at https://comic.fudaixuexue.eu.cc. Flare live output is not yet verified. / 已部署到上述 dev 域名，Flare 真实成图尚未验收。

## Scope / 功能边界

This independent HTTP Worker is entered only through a manual command. It reads a persisted, successful story and up to three of that story's original photos from the same owner's private D1/R2. It does not call or modify the story Worker, queue work after upload/story generation, or participate in the automatic pipeline. A `story_id` is the logical task; each explicit generation makes a separate `run_id`, with its own result and history. Every run draws **one 1024×1536 portrait 2×2 page** from the four story panels, without text or speech bubbles.

这是独立 HTTP Worker，只由本地命令手动触发。从私有 D1/R2 读取已保存且成功的故事和同一用户最多三张原图，不调用或改动故事 Worker，不绑定上传或故事后的自动触发、队列或定时器，也不参与自动部署管道。一个 `story_id` 对应一个逻辑任务；每次主动生成使用新的 `run_id`，结果独立保存。每次把四格分镜画成**一张 1024×1536 竖版 2×2 漫画**，不让模型生成文字和对白。

| `--model` | Usage / 用途 | Adapter / 适配 |
| --- | --- | --- |
| `@cf/black-forest-labs/flux-2-klein-9b` | Default, first quality baseline / 默认、首选质量基线 | Workers AI multipart, ≤500px reference side, fixed 4 steps / multipart，参考图长边 ≤500px，固定4步 |
| `@cf/black-forest-labs/flux-2-klein-4b` | Fast draft / 快速预览 | Same input protocol as 9B / 输入协议与9B相同 |
| `openai/gpt-image-2.6-flare` | Quality comparison / 质量对照 | Workers AI binding, JPEG data URLs, medium quality PNG, ≤1024px reference side / Workers AI binding，JPEG data URL 输入，medium PNG，参考图长边 ≤1024px |

The Worker checks original R2 bytes, SHA-256 and dimensions against D1, then resizes through the Images binding and strips JPEG EXIF/GPS and comments. All three models use the AI binding. Flare submits JPEG data URLs and downloads the completed response's asset server-side. It accepts bounded inline PNG/JPEG or HTTPS assets from Cloudflare's AI image namespace and canonical R2 delivery endpoints, with no credentials or redirects, an 8 MiB cap and matching PNG/JPEG type and dimensions. The result goes to private R2; the provider asset URL is never logged, stored, or returned to the client. If Cloudflare delivers from a different host, verify it using synthetic input before changing the allowlist. Flare draws from Unified Billing credits and does not require a dedicated HTTP Gateway token. Review Cloudflare and the provider's retention terms before sending private photos; not logging request payloads in this Worker does not imply zero retention.

Worker 先用 D1 核对私有 R2 原图的字节数、SHA-256 和尺寸，再通过 Images binding 缩图并移除 JPEG 的 EXIF/GPS 与注释。三个模型都用 AI binding。Flare 传入 JPEG data URL，Worker 把完成响应中的成图下载到私有 R2。只接受有限大小的内联 PNG/JPEG 或 Cloudflare AI 图片域与标准 R2 地址上的 HTTPS 下载，不发送凭据、不跟随重定向，最多 8 MiB，并校验 PNG/JPEG 类型及尺寸。供应商 URL 不记日志、不入库、不返回客户端。若 Cloudflare 返回其他域名，先用合成图核实再调整白名单。Flare 使用统一计费余额，不需要单独的 HTTP Gateway 令牌。提交私人照片前请核对 Cloudflare 和供应商的留存条件；本 Worker 不记录请求正文不等于供应商零留存。

References / 参考文档：[Klein 9B](https://developers.cloudflare.com/changelog/post/2026-01-28-flux-2-klein-9b-workers-ai/), [Klein 4B](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/), [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/), [Flare model / 模型](https://developers.cloudflare.com/ai/models/openai/gpt-image-2.6-flare/), [Unified Billing / 统一计费](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

## Local command / 本地命令

Run the following in `worker-cloudflare/worker-comic`. Pass the dev URL explicitly; the CLI has no built-in destination. Use an existing `worker-story` result's `stories[].story_id` and the same user's existing Token file (owned by the caller, mode 0600). The story selection is read-only. The command does not rerun story inference. It automatically picks representative photos across panels; repeat `--photo-id` one to three times to select exact story photos for a fair model comparison. No raw images, arbitrary prompts or owner IDs can be sent by the CLI.

在 `worker-cloudflare/worker-comic` 运行。需显式填 dev Worker 地址，CLI 无内置默认远端地址。使用已有故事结果中的 `stories[].story_id`，以及同一用户的 Token 文件（属主为当前用户、权限 0600）。只读选取故事，不会重新生成故事。默认按分镜选代表照片；横评时可重复传 1–3 次 `--photo-id` 固定同一批故事内照片。CLI 不直接上传原图，也不接收任意提示词或 owner ID。

```bash
npm ci
npm run comic -- --list-models

# Use the deployed dev URL; set TOKEN_FILE and STORY_ID. / 使用已部署的 dev URL，自行设置 TOKEN_FILE 和 STORY_ID。
export COMIC_URL=https://comic.fudaixuexue.eu.cc
npm run comic -- generate --base-url "$COMIC_URL" --token-file "$TOKEN_FILE" \
  --story-id "$STORY_ID" --model '@cf/black-forest-labs/flux-2-klein-9b' --confirm-model-call

# The following commands never call a model. / 以下命令不调用模型。
npm run comic -- list --base-url "$COMIC_URL" --token-file "$TOKEN_FILE" --story-id "$STORY_ID"
npm run comic -- status --base-url "$COMIC_URL" --token-file "$TOKEN_FILE" --run-id "$RUN_ID"
npm run comic -- download --base-url "$COMIC_URL" --token-file "$TOKEN_FILE" \
  --run-id "$RUN_ID" --out "$PRIVATE_DIR/comic.png"
```

The CLI prints its `run_id` to stderr before submitting. The default is a new UUID each time; **only do this to intentionally pay for another result**. After timeout/disconnect, use `status` first. Reusing `--run-id` with identical inputs returns the saved attempt without calling a model again; different inputs return a conflict. Do not use a new ID as an automatic retry. Download verifies MIME, byte count and SHA-256. Use an existing private directory (0700), with a filename matching the returned MIME; the CLI creates a 0600 file and will not overwrite.

CLI 在提交前把 `run_id` 打到 stderr。默认每次生成新 UUID，**仅在明确要再生成一份结果时这样做**。若超时或断连，先通过 `status` 查这个 ID。相同参数复用 `--run-id` 只返回原记录，不再次调用模型；同一个 ID 换参数返回冲突。不要把新 ID 当成自动重试。下载时校验 MIME、字节数和 SHA-256；使用现有私有目录（0700），文件后缀按返回类型选择，文件以 0600 新建，不覆盖旧文件。

## HTTP and storage / 接口与存储

| Request / 请求 | Behavior / 行为 |
| --- | --- |
| `GET /daily?date=YYYY-MM-DD` | Owner-scoped read-only feed from successful story runs; without `date`, selects the newest saved story date. At most 30 rows. Each story includes its latest successful comic, if any. Download with the existing authenticated image endpoint. / 只读返回登录用户的成功故事和各自最新的成功漫画；省略日期时选择最近有故事的一天，最多 30 条。成图继续走已有的鉴权下载接口。 |
| `POST /comics` | JSON `{story_id,run_id,model?,photo_ids?,confirm_model_call:true}`. Waits for one attempt; new success 201, repeat 200 or in progress 202. / 等待一次手动生成；首次成功 201，复用 200 或正在生成 202。 |
| `GET /comics?story_id=...` | Up to 50 runs, newest first, use `next_cursor` as `cursor`. / 倒序最多 50 条，后续传 `cursor`。 |
| `GET /comics/:run_id` | State and immutable output metadata; no inference. / 查询状态和成图元数据，不推理。 |
| `GET /comics/:run_id/image` | Streams private R2 bytes only for a succeeded run and its authenticated owner. / 仅所属用户可下载已成功的成图。 |

Migration `0006_comic_runs.sql` adds the history table without changing existing jobs or backfilling old data. The server registers the run in D1 atomically **before inference**, writes a new private R2 object under a per-owner deterministic run key, then marks D1 succeeded with its size, digest and output type. R2/D1 are not a transaction. If R2 succeeds but D1 confirmation fails, retain the object and reconcile from the run ID; do not delete or resubmit automatically. Timeout, invalid binary or an uncertain write leaves `needs_review` or `generating`. It may already have been billed. The profile, rendered prompt and source/transformed digests are frozen in each new row; give future semantics a new profile version and don't overwrite history.

迁移 `0006_comic_runs.sql` 仅增加历史记录表，不修改旧任务表、不回填。服务端在**推理前**原子登记 D1，成图按用户和 run ID 写入私有 R2，然后记录尺寸、摘要和输出类型并标记成功。D1 与 R2 无跨服务事务。若 R2 写入后 D1 未确认，保留对象并按 run ID 核查，不自动删图或重发。超时、无效图像或不确定写入会留在 `needs_review` 或 `generating`，可能已计费。每次冻结模型参数、完整提示词和原图/提交图摘要；将来改生成语义时新增 profile 版本，不覆盖历史。

## Local verification / 本地验证

```bash
npm run typecheck
npm test
npm run db:migrate:local  # Local Wrangler D1 only / 仅本地 Wrangler D1
WRANGLER_SEND_METRICS=false npm run build  # Wrangler dry run / 只打包
```

Tests run the CLI through local HTTP/workerd with real temporary D1 and R2, mock all providers and image transforms, and block outbound access. The normal local config deliberately has no AI/Images bindings and no generation enabled. Migration state is not implicitly shared with a sibling Worker's local D1; read/test fixtures explicitly.

测试经本地 HTTP/workerd 运行 CLI，使用真实临时 D1/R2，模拟三种模型与图片变换，禁止访问外网。普通本地配置不绑定 AI/Images，保持生成关闭；本地迁移状态不会隐式共用其他 Worker's D1。

## Dev deployment prerequisites / Dev 部署前置条件

**Future deployments and account changes require approval / 后续部署与账号更改需授权。** Verify the existing dev domain, private buckets and shared D1 migration before deploying. In dev, `COMIC_ALLOW_ALL_AUTHENTICATED_USERS` lets active users with valid tokens generate only from their own stories; disable it to use `COMIC_GENERATOR_OWNER_IDS` (empty means nobody). `COMIC_FLARE_ENABLED` is a Boolean dev switch. No `COMIC_GATEWAY_ID` or `CF_AIG_TOKEN` is read by this version. An old failed or uncertain run is not resubmitted on the new adapter. A live inference check requires separate authorization; prefer synthetic inputs.

部署前核对现有 dev 域名、私有 R2 桶和共用 D1 迁移状态。dev 的 `COMIC_ALLOW_ALL_AUTHENTICATED_USERS` 允许持有有效令牌的活跃用户仅用自己的故事生成；关闭后使用 `COMIC_GENERATOR_OWNER_IDS` 白名单（为空则无人可用）。`COMIC_FLARE_ENABLED` 为布尔开关。此版本不再读取 `COMIC_GATEWAY_ID` 或 `CF_AIG_TOKEN`。原来失败或状态不确定的任务不会在新适配器上重新提交。真实生图验收需单独授权，优先用合成图。

Migration `0006` is already applied on the current dev D1, and the private buckets remain unchanged. / 当前 dev D1 已应用迁移 `0006`，私有 R2 桶不变。

For another checkout / 换机器接手：clone or pull `master`, run `npm ci` from this directory, and set `COMIC_URL=https://comic.fudaixuexue.eu.cc`. Use a securely available Token file on that computer; Git deliberately does not carry credentials or user data. / 拉取 `master`，在本目录运行 `npm ci`，使用同一个线上地址及新机器上安全可用的 Token 文件。Git 不包含凭据和用户数据。
