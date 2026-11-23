# 每日故事 Worker

独立的手动 HTTP Worker：从已有 `photos` / `photo_analyses` 读取某个用户一天的图片摘要，通过可选的原生 Workers AI 模型整理成**由AI自主决定数量的故事，每个故事包含四格分镜及生图提示词**，直接返回 JSON。只接受摘要文字，不读取 R2、不生成图片、不写 D1；不新建表、不改变现有上传/分析管道，没有 Queue 或 Cron。

## 当前版本与上线状态

**自动数量/多模型版本已于2026-11-23部署。** 默认Qwen版本为 `v5`，Gemma版本为 `v5-gemma`；此前验证的部署ID为 `d708facc-46b3-4f14-90ea-63a51cd3d4e6`（后续实际版本以Wrangler发布记录为准）。168项本地测试、类型检查、配置与域名预检通过，线上404/405/401检查通过。本次仅部署，没有执行真实模型调用；新版本生成质量和模型可用性仍待真实验收。

v1–v4的配置及指纹保持不变。新版本移除固定数量输入，保留原有鉴权、摘要完整性、四格、合法来源和精选覆盖披露。

## 目录与共享依赖

| 入口 | 用途 |
|---|---|
| [`src/index.ts`](src/index.ts) | `POST /stories`、用户鉴权、参数检查及响应 |
| [`src/input.ts`](src/input.ts) | 按北京时间上传日读取指定用户的全部摘要 |
| [`src/references.ts`](src/references.ts) | 短编号映射、分镜来源汇总和覆盖披露 |
| [`src/model.ts`](src/model.ts) / [`src/output.ts`](src/output.ts) | 单次模型调用、自动数量范围及四格来源校验 |
| [`scripts/story.mjs`](scripts/story.mjs) | 手动触发并输出或保存故事 JSON |
| [`config/story-profiles.json`](config/story-profiles.json) | 固定模型、提示词、输出 Schema、版本和资源上限 |
| [`config/selection.mjs`](config/selection.mjs) | CLI/Worker共用的模型和锁定版本选择规则 |
| [`scripts/config.mjs`](scripts/config.mjs) | 离线配置检查与仅追加版本的指纹锁维护 |
| [`scripts/preflight.mjs`](scripts/preflight.mjs) | 在线只读核对账号、域名归属及 Wrangler 域名冲突预览 |

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
npm run story -- --list-models
```

`build` 只是 Wrangler dry-run。测试使用临时真实 D1、合成摘要和 mock AI，阻止公网访问；既不读取现有用户照片，也不调用真实模型。贯通测试从手动脚本经真实本地 HTTP 调用 workerd，在临时 D1 中读取摘要，通过测试夹具注入 mock AI，验证完整故事返回及0600文件保存；另有业务与故障注入测试。

`wrangler.local.jsonc` 没有 AI binding，且生成开关为 false：Workers AI 并不会本地推理，不能因为运行 `wrangler dev` 就静默调用远端模型。其独立本地 D1 不会自动共享上传 Worker 的 `.wrangler` 状态。`npm run db:migrate:local` 仅给本 Worker 的本地开发库应用共用迁移；完整可运行示例以 `npm test` 为准。

### 验收记录（2026-11-23）

- 配置指纹、D1 连接配置和手动触发边界检查通过。
- `npm run typecheck` 通过；`npm test` 共 **168 项通过**，含 thinking 开关、v1 指纹保留、阶段超时与域名冲突保护。
- `npm run build` 的 Wrangler dry-run 打包通过，不代表已部署。
- 已覆盖脚本 → 本地 HTTP → workerd → 临时 D1 → mock AI → 0600 JSON 文件的完整链路。
- 历史线上v4曾通过一次真实验收（不是新v5的验收）：14份摘要完整输入 → 3个故事、每个4格，HTTP 200；分镜精选8张，另外6张在coverage中明确列出。客户端独立核对了合法引用和覆盖统计。
- 本次端到端约89.2秒，其中等待AI响应头87.87秒；用量为2,643输入tokens、1,292输出tokens。这是单次观测，不是延迟保证。
- 历史 v1 曾触发应用90秒上限，未返回usage，也未自动重试。不能据此断定没有处理或收费。此次修复没有升级套餐或修改付款方式；单次成功不代表全部日期、数量和网络环境的性能保证。

## 手动运行脚本

dev 接口已部署到 **https://story.fudaixuexue.eu.cc**，`STORY_GENERATION_ENABLED: true`；`workers.dev` 与预览 URL 仍关闭，所有调用要求独立用户 Token。本地配置继续关闭生成且不绑定 AI。脚本不内置默认远端地址，必须显式传入，不会把请求误发给上传 API。

**以下命令可用于已上线的新版本。** 全部摘要仍作为输入，AI自行判定故事数量；分镜允许精选代表照片，未被引用的照片会明确列出。 下列命令仍会发起新的模型调用，不是查看先前结果，也不是幂等恢复；不要为查看已保存故事而重复调用。

```bash
# 先进入项目目录；仓库根目录没有 package.json。
cd /Users/haoming/code/LookMe-Worker/worker-cloudflare/worker-story

npm run story -- \
  --base-url 'https://story.fudaixuexue.eu.cc' \
  --token-file '/已有受限目录/user1.token' \
  --date 2026-11-21 \
  --model '@cf/qwen/qwen3.8-27b' \
  --confirm-model-call
```

- 现有独立用户 Token 即可，不需要 Cloudflare 管理凭据。Token 文件需归当前用户、权限 0600；不要传 Token 明文或 `owner_id`。
- `--date` 为北京时间的**上传日期**，与现有调试页一致，不是 EXIF 拍摄日期；覆盖 `[当天00:00, 次日00:00)`。本版支持 2000–2099 年，时区及时间口径在故事版本中固定。
- **移除 `--stories`**：继续传该参数会在读取Token和发请求之前报错。新版本让AI按场景和事件自行分组，不默认3个，不要求达到上限。当前资源上限仍为1–8个且不能超过照片数；这是预算保护，不是固定生成数量。
- `--model MODEL_ID` 可选，默认Qwen；模型选择表见下方。`--story-version`仅用于显式锁定版本，与模型不匹配时直接拒绝，不能覆盖历史版本的模型参数。所有故事模型仍读取同一分析版本v2（Gemma图片摘要），选择故事模型不会重做图片分析。
- 当前日期可以调用，但结果 `day_complete: false`，仅代表请求开始时的快照；要完整一天应在该日结束且摘要全部完成后调用。结束后的补上传不会追溯改变已经返回的故事。
- 没有任何自动触发。`--confirm-model-call` 表示本次手动请求可能产生 Workers AI 费用；重复运行会再次推理，**没有跨请求缓存/幂等登记，也不宣称收费恰好一次**。
- 只进行一次 HTTP 请求，不跟随重定向、不自动重试。故事v2及之后版本的模型调用与读正文合计最多180秒，脚本等待最多210秒；旧故事v1仍是90秒。超时、断连、取消或输出异常可能已经产生费用；应先核对情况，不自动重发。脚本只接受 HTTPS（localhost/127.0.0.1/::1 可用 HTTP）。

默认把故事 JSON 返回到终端。如果要保存，使用仓库外已存在的受限目录（0700）：

```bash
npm run story -- \
  --base-url 'https://story.fudaixuexue.eu.cc' \
  --token-file '/已有受限目录/user1.token' \
  --date 2026-11-21 --model '@cf/google/gemma-4-26b-a4b-it' --confirm-model-call \
  --out '/已有受限目录/2026-11-21.story.json'
```

`--out` 以 0600 新建，拒绝覆盖；在请求前占用输出路径，失败可能留下空文件。不要把故事、摘要、凭据或输出文件提交 Git。JSON 包含用户的生活记录，默认没有云端故事副本。

### 支持的模型

| `--model` 完整ID | 默认故事版本 | 故事数量 | 参数差异 |
|---|---|---|---|
| `@cf/qwen/qwen3.8-27b` | `v5` | AI自动判断 | 关闭thinking，`reasoning_effort: low` |
| `@cf/google/gemma-4-26b-a4b-it` | `v5-gemma` | AI自动判断 | 关闭thinking，不发送Qwen专用的`reasoning_effort` |

两个模型目前均采用非流式Chat Completions、JSON Schema、6,144 completion tokens预算和180秒服务端等待上限；不是速度或质量相同的保证。模型价格、账号可用性及实际生成质量需分别验证。未知模型会在推理前拒绝，没有静默模型回退。

离线查看：`npm run story -- --list-models`。`--model`只接受本项目已适配并配置的模型，不是任意供应商URL。新增模型需核对协议、为它追加独立profile并锁定，在 `model_defaults` 中指向新版本；不能把旧profile的model字段直接改掉。

新脚本显式选择旧版本时，仍使用该版本原有默认数量（目前3个）；HTTP旧协议允许在显式旧版本下指定 `story_count`。默认及任一新模型自动版本都拒绝 `story_count`，不会暗中忽略。旧版本仅供兼容，不是新自动数量用法。

## 接口

`POST /stories`，`Authorization: Bearer <用户Token>`，`Content-Type: application/json`：

```json
{"date":"2026-11-21","model":"@cf/qwen/qwen3.8-27b"}
```

新请求接受 `date`、可选 `model`、可选 `story_version`；只允许配置模型，不接受用户自报owner、摘要、提示词或任意生成参数。省略模型时使用默认Qwen，显式版本与模型冲突返回400。服务端通过 Token 哈希、到期、撤销状态和 active 用户确定归属，参数化查询 D1。整日照片最多 128 张，序列化输入最多 64 KiB；超过限制会明确拒绝，**不会只用前若干张或截断摘要**。这些是保守应用上限，不是模型官方上下文上限；暂未实现多批次压缩，避免额外调用和隐藏费用。

一天内只要有任何照片的指定版本摘要未完成、失败或待核查，就返回 `409 summaries_not_ready`（含状态计数），不以部分摘要冒充全天。模型字段与固定分析版本不匹配同样拒绝。摘要只作为不可信 JSON 数据，system prompt 不执行摘要中的指令；这降低注入风险，不是事实正确性的保证。

成功 `200` 的主要字段：

```text
request_id, date, timezone, date_basis, snapshot_at, day_complete
photo_count, story_count（实际返回数）, story_count_mode（auto）, story_version, analysis_version, model
input_sha256, provider_request_id, usage, model_timings, sources[], coverage
daily_summary
stories[]:
  title, summary, source_photo_ids[], image_prompt
  panels[4]: panel(1–4), description, source_photo_ids[], image_prompt
```

`image_prompt` 是一张2×2四格漫画的完整生图提示词；`panels[].image_prompt` 是各分镜的独立提示词。图片 ID 仅用于来源追溯，不是公开 URL，也不会自动提交给图像模型。后续生图仍需实现、鉴权、单独授权。

v4及新的自动数量版本始终将当日全部已完成摘要作为输入，但允许分镜精选代表照片。故事来源由分镜引用汇总，同一照片可在一个故事内被多个分镜引用，不得跨故事重复归属。服务端仍严格校验故事数量范围（旧版固定N）、四格结构、文本长度和本次用户的合法来源，不接受陌生编号、伪造ID或截断回复。语义质量/事实忠实度仍需人工检查。

v4及之后版本的 `coverage` 由服务端计算，不是模型自行声明：

- `input_photo_count`：完整输入的照片数；`sources`同样保留全部输入照片。
- `referenced_photo_count`：实际被分镜引用的不同照片数量。
- `unreferenced_photo_ids`：未被分镜引用的真实照片UUID清单；空列表表示全部被引用。
- `all_photos_referenced`：是否全部被引用。未被引用不等于没有作为模型输入，返回清单是为了透明披露去重结果。

旧v1/v2/v3继续要求每张照片都在分镜中出现。新版并未放宽跨用户隔离、引用合法性或四格结构，仅根据用户确认区分了“输入完整”与“分镜全引用”。

| 状态 | 含义 |
|---|---|
| 400 / 415 | 请求字段、日期、模型/版本不匹配、自动模式携带story_count或编码错误 |
| 401 | 凭据无效、过期、撤销或用户停用 |
| 409 | 摘要未齐或固定分析版本数据不一致 |
| 413 | 请求、照片数或整日摘要超限 |
| 422 | 当日无照片；旧固定数量版本还会检查照片数是否不足N |
| 502 / 504 | 模型失败、结果非法或超时，不自动重试 |
| 503 | 生成功能关闭、未配置 AI、配置锁校验失败或存储不可用 |

错误返回 `model_call_attempted`；已进入模型调用阶段的错误附带 `may_have_been_billed: true, automatic_retry: false`。没有错误响应的客户端断连同样不能认定没有收费。响应禁止缓存；阶段日志含请求ID、模型/故事版本、thinking开关、token上限、阶段、响应状态、字节数及 wall time，不含摘要、故事、Token。dev的invocation logs已在Wrangler中启用。错误中的 `model_stage` 区分等待响应头、读取正文和校验输出；成功中的 `model_timings` 返回各阶段耗时，不能将wall time当作CPU时间。没有 CORS、公开注册或速率限制；部署前应评估哪些用户能使用此付费能力及预算保护。

### 排查 `invalid_story_result`

本地脚本调用的仍是线上模型。`HTTP 502: invalid_story_result` 表示模型已返回，但正文JSON或业务校验没有通过，不是运行目录、Token文件路径或本地Node启动错误；该错误不能通过反复重试来诊断。

诊断版本保留顶层错误码，并额外返回：

- `validation_code`：明确区分JSON非法、字段错误、文本过长、来源ID非法/重复、故事数量不符、漏图、顺序或分镜错误。
- `validation_path`：如 `$.stories[0].source_photo_ids`，定位到字段；不返回错误正文或实际ID。
- `request_id`、`provider_request_id`（供应商有返回时）、`model_stage` 和已返回的 `usage`；失败仍可能计费。

更新后的脚本会显示校验原因、字段位置、阶段和请求ID。把这些**非秘密诊断字段**用于查日志即可，不要发送Token。旧版已丢弃的失败正文无法事后恢复，也不能仅凭泛化错误断定是漏图还是来源错误。诊断修复不放宽校验，不自动修补错误来源，更不会自动再调模型。仅诊断修复那次发布没有新增模型调用。后续根据错误字段定位为分镜与故事级来源名单不一致，并在新版本中消除重复名单；原始失败正文未保存，不能事后恢复。

### v3/v4 来源一致性设计

v2 的 `unknown_source_id` 如果发生在 `$.stories[0].panels[2].source_photo_ids`，具体表示第一个故事第三格的引用不属于模型同时生成的故事级名单，或者该引用本身无效；不能仅凭这个错误区分跨故事引用与UUID抄写错误。

v3 改用单一来源列表，避免模型维护两份重复名单：

- 仅向模型发送本次请求内的 `P001`、`P002` 等短编号，不发送照片UUID作为引用标识。
- 每次调用的JSON Schema将分镜引用限制为本次编号枚举，故事数限制为请求的N。
- 模型只输出分镜引用，不输出故事级来源；服务端严格映射回已鉴权查询得到的真实UUID，再汇总故事来源。
- 服务端只按已有分镜号及可信照片顺序排序，不修改模型文字、不猜测非法ID、不补图或删除引用。
- 始终拒绝未知编号、单格重复编号、跨故事重复归属和非四格结果。v3还要求分镜引用覆盖全部输入；v4按已确认策略允许精选，并显式披露未引用清单，不追加模型修复调用。
- 对外JSON格式不变，`sources`、故事及分镜中的 `source_photo_ids` 始终为真实UUID。v1/v2的配置指纹和调用协议保持不变。

本地共107项测试通过，包括真实本地HTTP下v2/v3/v4链路。v3一次真实验证时引用覆盖为12/14，被旧规则拒绝；在用户明确选择“允许总结去重并披露未引用清单”后新增v4，不修改v3历史规则。v4一次真实验证以14份完整输入生成3个故事，引用8张并明确列出另外6张，独立引用检查通过；各次调用分别获准，没有自动重试。

## 可复现配置与发布边界

- `config/story-profiles.json` 固定模型、system prompt、JSON Schema、分析版本、时间口径、采样参数及资源上限；`story-profiles.lock.json` 保存递归规范化 SHA-256。
- 发布前与运行时检查指纹。`npm run profiles:lock` 只追加新版本，不能修改/删除已锁定版本。当前适配Qwen与Gemma的Chat Completions协议、北京时间上传日和输出 revision 1；配置不是任意模型/时区的通用兼容层。
- Qwen故事v2及之后版本用 `chat_template_kwargs.enable_thinking: false`、`reasoning_effort: low`、`stream: false`、`response_format: json_schema`、`max_completion_tokens: 6144`，并在提示词中限制文字长度。这是应用预算选择，不保证所有8故事或超长输入都能在预算内完成；截断时明确失败，不自动增加预算或二次修复调用。
- `reasoning_effort: low` 不等于关闭思考：官方Schema的 `enable_thinking` 默认是true。旧v1未发送该开关，且将推理和完整非流式输出限制在90秒内。v2显式关闭思考并把等待上限改为180秒；v1指纹保持不变，只有新版本使用新参数。
- `npm run config:check` 离线核对版本、现有上传端账号/数据库、唯一迁移来源及手动触发边界；`prebuild` 自动执行该检查。
- 所有云端配置只通过 Wrangler 文件和命令应用。dev 已获准部署到上述独立域名，此前已验证部署版本为 `d708facc-46b3-4f14-90ea-63a51cd3d4e6`（后续以Wrangler记录为准），支持自动数量和模型选择（2026-11-23）；不改变上传/图片分析 Worker 的配置。
- 再次发布使用 `npm run deploy:dev`：依次执行离线配置检查、类型检查、本地测试、在线只读 `deploy:preflight`，最后由 Wrangler 应用文件配置。部署命令不自动调用模型。账号或目标 Worker 不明确时停止，不覆盖不明服务。
- `npm run deploy:preflight` 通过官方 Wrangler 认证上下文核对域名归属和 `domains/changeset`，遇到 DNS 冲突、移除、替换或未知返回结构即停止；该预览不修改 DNS，不直接通过管理 API 应用配置，也不输出 Token。直接 DNS 列表权限不足时不据此宣称 DNS 为空。
- 首次 Worker 尚不存在时，域名预览会返回10090。先在 Wrangler 文件中保持 `routes: []`、关闭公开入口与生成，发布私有 Worker；随后将已确认域名及开关写回配置，再经上述预检发布。此次已完成该两阶段流程。换账号或首次域名选择需另行确认，不能复用旧账号的授权假设。
- 修改超时、输出预算、提示词或其他模型参数必须追加故事版本并重新锁定，不能原地改写已发布 v1；延长等待还需同步核对脚本客户端超时。真实调用仍需单独授权，不因发布成功而自动重试。
- 不把本 Worker 加入 `../scripts/pipeline.mjs deploy-dev`，不触碰已上线自动分析设置；当前无需新增迁移。

## 本次耗时、Token 与费用（已部署）

本节功能已于2026-11-23通过Wrangler部署，168项本地测试通过；线上路由、鉴权及新错误响应计时字段检查通过。计费错误采用mock回归验证，未故意制造真实欠费、未查询实际账单、未升级套餐、未新增真实模型调用。

返回故事JSON以及 `--out` 保存后的终端摘要会包含：

| 字段 | 含义 |
|---|---|
| `model` / `story_version` | 服务端实际选择的模型与固定配置版本 |
| `request_duration_ms` | 服务端从进入handler到准备返回的耗时（含鉴权/查询/模型/校验，不含完整网络传输） |
| `client_request_ms` | 本地脚本从发出请求到读完JSON的耗时，不含本地写文件；由脚本添加 |
| `model_timings` | AI响应头等待、正文读取、模型调用总耗时与响应字节数 |
| `usage` | 供应商返回的输入、输出、总tokens；如果提供，还保留缓存输入和reasoning tokens |
| `cost.pricing` | 官方公开单价快照，含USD/每百万tokens、缓存价（若有）、核对日期和来源链接 |
| `cost.estimated_usd` | 按已知用量计算的估算总价；缺用量或缺单价时为null，不冒充零费用 |
| `cost.input_usd` / `output_usd` | 估算的输入/输出费用，只有可估算时出现 |
| `cost.actual_billed_usd` | 始终为null，本Worker没有读取实际账单 |

价目存于 `config/model-pricing.json`，独立于固定生成配置；核对日期为2026-11-23，不会在每次请求时上网抓价。当前Qwen输入/输出为0.45/3.20美元每百万tokens，缓存输入0.05美元；Gemma输入/输出0.10/0.30美元，未找到缓存输入单价。

当缓存用量和价格都明确时按缓存价计算；否则按全部输入的标准价估算，并标记 `basis: all_input_at_standard_rate`，不假装知道缓存折扣。reasoning tokens不在completion tokens之外重复计价，total tokens也不额外加一遍。估算不抵扣免费额度、不包含Worker运行、存储、税费及之前失败请求的费用；以Cloudflare账单为准。

超时/断连通常没有usage，显示“用量未返回、费用无法估算”。模型返回结果但业务校验失败时，若已有usage仍保留用量和估算。所有耗时是wall time，不等于CPU时间。

### 欠费与额度提示

- 上游HTTP402：`model_payment_required`，提示检查Cloudflare Billing；只能确认上游要求处理付款问题，不能确认欠费金额或具体原因。
- 官方内部码3036：`model_quota_exceeded`，每日免费额度耗尽，不等于欠费。
- 官方内部码5035：`model_paid_plan_required`，需要Workers Paid套餐，不等于已有欠款。
- 内部码3040：`model_capacity_exceeded`，平台容量不足，不是欠费。
- 其他429：`model_rate_limited`，未能确认计费原因，不引导用户盲目充值；普通403/5xx也不误报欠费。

API错误含固定中文 `message`，脚本依据错误码输出中文提示、模型、耗时、用量、单价和估算。仅有异常文本、未知错误包裹或无明确计费信号时保留通用失败，不靠关键词猜欠费。上游正文读取限制16KiB/2秒，永不直接输出或记录可能包含秘密的错误正文。仍保留 `model_call_attempted`、`may_have_been_billed`，不承诺失败请求免费，也不自动重试。

## Cloudflare 付费方式

本项目通过原生 Workers AI binding 调用模型，未配置阿里/Qwen API Key 或 AI Gateway 预付路由。运行时推理计入部署账号的 Cloudflare Workers AI 用量，不需要向阿里云另行充值。

截至2026-11-22，官方文档列出：

- 每天10,000 Neurons免费额度，00:00 UTC重置（北京时间08:00）；Free计划超额后会报错，不会自动变成付费订阅。
- 超出免费额度的通常路径是订阅Workers Paid，最低每账户每月5美元；Workers AI超额用量按每1,000 Neurons 0.011美元另计，不是包含在5美元里无限使用。
- Qwen模型当时展示的单位价格为每百万输入tokens 0.45美元、每百万输出tokens 3.20美元、缓存输入每百万0.05美元。实际账单还取决于免费额度抵扣和供应商计量；应用收到的token用量只能用于估算，不是付款凭证。
- 添加付款方式：Cloudflare Dashboard选择项目所属账号 → **Billing → Subscriptions → Payment methods** → **Add Payment Method**；在Cloudflare页面填写银行卡或可用钱包，再按控制台提示购买Workers Paid。不要把支付信息或管理凭据发到聊天/源码。
- 用量在账户的Workers AI页面查看，账单在Billing查看。没有账单读取权限不代表没有额度或欠费；本次诊断未更改订阅、付款方式或套餐。

## 官方协议依据

- [Qwen3.8-27B 模型](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)
- [输入 JSON Schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/sync-input.json)
- [输出 JSON Schema](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/sync-output.json)
- [Gemma输入Schema](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/sync-input.json)
- [Gemma输出Schema](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/sync-output.json)
- [Workers AI 错误码](https://developers.cloudflare.com/workers-ai/platform/errors/)
- [Workers AI 价格与免费额度](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers 套餐](https://developers.cloudflare.com/workers/platform/pricing/)
- [添加付款方式](https://developers.cloudflare.com/billing/get-started/create-billing-profile/)

历史v4完成过一次真实验收；新增v5/v5-gemma已部署并完成本地mock与线上路由/鉴权验收，尚未调用真实模型。模型输出的事实忠实度仍需人工检查，单次成功不代表所有输入都可靠，也不是性能SLA。进一步真实调用按明确请求执行，不自动重试。
