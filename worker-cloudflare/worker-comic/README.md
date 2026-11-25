# LookMe Comic Worker / LookMe 漫画 Worker

**Status / 状态:** deployed to dev at https://comic.fudaixuexue.eu.cc. No live inference yet. / 已部署到上述 dev 域名，尚未验收真实生图。

## Scope / 功能边界

This independent HTTP Worker is entered only through a manual command. It reads a persisted, successful story and up to three of that story's original photos from the same owner's private D1/R2. It does not call or modify the story Worker, queue work after upload/story generation, or participate in the automatic pipeline. A `story_id` is the logical task; each explicit generation makes a separate `run_id`, with its own result and history. Every run draws **one 1024×1536 portrait 2×2 page** from the four story panels, without text or speech bubbles.

这是独立 HTTP Worker，只由本地命令手动触发。从私有 D1/R2 读取已保存且成功的故事和同一用户最多三张原图，不调用或改动故事 Worker，不绑定上传或故事后的自动触发、队列或定时器，也不参与自动部署管道。一个 `story_id` 对应一个逻辑任务；每次主动生成使用新的 `run_id`，结果独立保存。每次把四格分镜画成**一张 1024×1536 竖版 2×2 漫画**，不让模型生成文字和对白。

| `--model` | Usage / 用途 | Adapter / 适配 |
| --- | --- | --- |
| `@cf/black-forest-labs/flux-2-klein-9b` | Default, first quality baseline / 默认、首选质量基线 | Workers AI multipart, ≤500px reference side, fixed 4 steps / multipart，参考图长边 ≤500px，固定4步 |
| `@cf/black-forest-labs/flux-2-klein-4b` | Fast draft / 快速预览 | Same input protocol as 9B / 输入协议与9B相同 |
| `openai/gpt-image-2.6-flare` | Quality comparison / 质量对照 | Cloudflare AI Gateway OpenAI-native image edits, medium quality PNG, ≤1024px reference side / Gateway 的 OpenAI 原生编辑接口，medium PNG，参考图长边 ≤1024px |

The Worker verifies original R2 byte count, SHA-256 and JPEG dimensions against D1 before resizing through the Images binding. Only processed JPEGs are submitted; pre-scan JPEG metadata such as EXIF/GPS and comments is stripped. No public photo URL, no VPS. Flare uses the provider-native Gateway endpoint and inline base64 results, not a unified endpoint that returns an image URL. It rejects unexpected output instead of fetching URLs supplied by a model. The Gateway request disables log collection, payload logging, and caching, and sets one attempt. Verify the dedicated Gateway settings and its billing/ZDR terms separately before sending any personal photo. An attached Cloudflare card is not necessarily a funded Unified Billing balance.

Worker 先用 D1 核对私有 R2 原图的字节数、SHA-256 和 JPEG 尺寸，再通过 Images binding 缩图。只提交处理后的 JPEG，并去掉扫描数据之前的 EXIF/GPS 等元数据和注释；不公开照片，不经过 VPS。Flare 走 Gateway 的供应商原生接口并读取内联 base64，不走返回图片 URL 的统一接口；遇到异常输出不会去访问模型返回的 URL。Gateway 请求关闭日志收集、正文日志和缓存，并限制为一次尝试。发送私人照片前仍须独立核对专用 Gateway 的配置、计费与零数据留存条件；Cloudflare 已绑卡不等于统一计费余额已充值。

References / 参考文档：[Klein 9B](https://developers.cloudflare.com/changelog/post/2026-01-28-flux-2-klein-9b-workers-ai/), [Klein 4B](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/), [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/), [Gateway OpenAI provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/), [OpenAI Images Edits](https://developers.openai.com/api/reference/resources/images/methods/edit).

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

**Future deployments and account changes require approval / 后续部署与账号更改需授权。** Configure a verified independent HTTP route in `env.dev.routes`; the dev config binds the verified custom domain and enables Klein generation for every valid, non-revoked LookMe Token on an active account in dev. Each account can only use its own story and image records. Flare remains disabled. The dev-only `COMIC_ALLOW_ALL_AUTHENTICATED_USERS` flag grants this access. Omit it or set it to false to fall back to `COMIC_GENERATOR_OWNER_IDS` (empty = nobody). Before any new deployment, verify the private R2 buckets/Images binding, and use Wrangler to apply the shared migration to the intended dev D1 before deployment. For Flare, fill `COMIC_GATEWAY_ID`, use Wrangler to set the `CF_AIG_TOKEN` secret scoped to the approved authenticated Gateway, independently verify log/retry and billing settings, then enable `COMIC_FLARE_ENABLED`. A separate approved manual command is needed for any live smoke test; use a synthetic story and photos first.

在 `env.dev.routes` 中配置并核对独立 HTTP 路由。当前 dev 配置已绑定核验过的域名，调试阶段允许所有有效、未撤销且所属用户未停用的 LookMe Token 生成 Klein 漫画，只能使用自己的故事及图片；Flare 仍关闭。这个权限由仅在 dev 开启的 `COMIC_ALLOW_ALL_AUTHENTICATED_USERS` 控制；关闭或省略该开关后，恢复到 `COMIC_GENERATOR_OWNER_IDS` 白名单（为空则无人可生成）。重新部署前核对私有 R2 与 Images binding，用 Wrangler 对目标 dev D1 应用共用迁移。启用 Flare 前填入 `COMIC_GATEWAY_ID`，以 Wrangler 设置仅授权专用 Gateway 的 `CF_AIG_TOKEN` Secret，并单独核对该 Gateway 的日志、重试与计费配置，再打开 `COMIC_FLARE_ENABLED`。真实验收须另经授权手动发命令，优先使用合成故事和照片。

Deployment record / 部署记录 (2026-11-25): `lookme-comic-dev`, current version `8006ee91-eb45-4c30-824b-d9ea93cfc613`. Shared migration `0006` applied and foreign keys checked; both R2 buckets verified private. / 共用迁移 `0006` 已应用并通过外键检查，两个 R2 桶确认私有。现有有效 Token 的生成权限已通过无成本接口验证。

For another checkout / 换机器接手：clone or pull `master`, run `npm ci` from this directory, and set `COMIC_URL=https://comic.fudaixuexue.eu.cc`. Use a securely available Token file on that computer; Git deliberately does not carry credentials or user data. / 拉取 `master`，在本目录运行 `npm ci`，使用同一个线上地址及新机器上安全可用的 Token 文件。Git 不包含凭据和用户数据。
