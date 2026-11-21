# 图片转文字 Queue Worker 部署与复现

应用目录：`worker-cloudflare/worker-image2txt/`。从 Skill 路径定位仓库；名称、账号、资源 ID 读取当前 Wrangler 配置，使用 package-lock 锁定工具，不复制历史账号或秘密。

当前使用 **Workers AI `@cf/google/gemma-4-26b-a4b-it`，analysis_version = v2**。历史 v1 是 Moondream；本消费者不再调用它，不需要 Moondream API Key。不能把旧 v1 消息直接重解释为 Gemma。

## 0. 授权与边界

- 用户明确要求完整 dev 部署和真实产出文字时，完成本地验证、缺失资源准备、已授权迁移、部署及一次合成小图验收；只要求写代码/文档时不进行远端变更或推理。
- 只导出 queue()，保持 workers_dev、preview_urls 关闭及 routes 为空。没有域名选择，不新增临时 fetch() 调试入口。
- 不发布上传 Worker，不自动接入上传后生产者，不修改真实用户或照片。保持 R2 私有，不为省 Base64 公开桶。
- 真实推理可能消耗 Workers AI 免费额度或产生账号已启用的费用。默认只调用一次授权合成图，不压测、不自动开通收费功能或升级套餐；若账号要求付费才能继续，暂停说明。
- 保留用户的工作区改动。先读 CLAUDE、应用 README、`skills/deploy_cloudflare/SKILL.md`、配置和迁移。版本化迁移唯一来源 `../worker-upload/migrations/`。

## 1. 本地验收

从应用目录执行：

```bash
npm ci
npm run typecheck
npm test
WRANGLER_SEND_METRICS=false npm run build
```

测试中的 AI.run 全部 mock，并禁止真实公网模型调用；`test/queue-fixture.ts` 是本地 Queue 的测试替身，不是生产入口。不要运行带真实 AI binding 的 wrangler dev 来代替 mock，它可能访问远端推理。

同时在上传目录运行 `npm run typecheck`、`npm test`。数据库 v2 复用现有分析表，不需要重写 0003 或新增一份同名表。

核对模型官方页面及输入/输出 schema：messages 中 image_url 为 data URL，关闭 thinking，最多 512 completion tokens，读取单条 choice、finish_reason=stop 的 content。默认语义详见应用 README，变更模型/prompt/参数需新 analysis_version。

## 2. 身份、资源与现有版本

```bash
npx wrangler whoami
npx wrangler deployments list --env dev
npx wrangler queues list --env dev
npx wrangler queues info <input_queue> --env dev
npx wrangler queues info <dead_letter_queue> --env dev
```

- 核对目标账号与已有 Worker 的项目归属；10007 才表示 Worker 不存在，权限错误不能当缺失。已有目标是此消费者才允许更新。
- 当前部署/Queue/日志权限通常为 user:read、account:read、d1:write、workers:write、workers_scripts:write、workers_tail:read、queues:write。先验证实际权限，不为 Wrangler 的全产品缺 scope 警告申请所有权限。
- 配置 AI binding 不需要把管理凭据放进 Worker。只有实际 AI 管理查询或发布明确缺权限时，核对 `login --scopes-list` 并在现有必要集合上补 `ai:write`；说明后由代理打开浏览器。授权超时/拒绝不无限重试。
- 核对 D1 实际迁移及 sqlite_master。仅用 `--command --json` 获取查询行；不要把远端 `--file --json` 导入汇总当查询结果。
- 查询 R2 dev-url 和 domain list，确认私有。读取队列消费者配置，不能接管用途不明的已有队列。

## 3. 缺失资源与迁移

已获对应授权且查重成功后才创建缺失输入 Queue/DLQ。名称取配置；不创建新的同义队列，不改已有留存策略。

```bash
npx wrangler queues create <dead_letter_queue> --env dev
npx wrangler queues create <input_queue> --env dev
npx wrangler d1 migrations list <database_name> --env dev --remote
npx wrangler d1 migrations apply <database_name> --env dev --remote
```

已有库的迁移先展示变更和影响并确认。0003 新增 photo_analyses 及索引，不覆盖照片，但外键禁止删除被分析引用的照片。已应用则复用；结构冲突先停下，不执行完整 schema.sql 覆盖。migration list 可能初始化迁移管理表，不称严格只读。

验证迁移记录、新表结构、PRAGMA foreign_key_check。核对输入 Queue 的每批1条、并发2、重试8次、默认60秒及 DLQ；Free 当前留存24小时，以远端实际值为准，DLQ不是永久备份。

## 4. AI binding 与发布

`env.dev` 必须包含 `"ai": { "binding": "AI" }`，同时保留 D1/PHOTOS、Queue consumer 和 observability。**无需 MOONDREAM_API_KEY 或其他外部模型 Secret**；旧 Secret 即便存在也不擅自删除/轮换。

```bash
npx wrangler deploy --env dev
npx wrangler deployments list --env dev
npx wrangler queues info <input_queue> --env dev
```

记录实际版本、绑定和消费者；此 Worker 没有 HTTP URL，不拼造 workers.dev 地址，不套用上传 API 的 401/404 检查。发布响应丢失先查版本，不盲重发。发布后立刻列部署记录可能仍显示旧版本，应等后续读取得到新版本100%活动记录，再投验收消息，不因短暂旧列表重复发布。平台要求添加付款方式时停止，不自动开通。

## 5. 一次真实合成图验收

1. 复用本次已有的受限验收目录和测试 photo，不重新生成一批用户/图片。没有检查点时先创建仓库外0700目录，以0600保存非秘密 checkpoint、合成 JPEG 及日志。测试用户需已获授权，不触碰真实用户。
2. 合成一张确定内容的小 JPEG，如白底红色方块和蓝色圆形。先上传私有 R2，再登记 D1 照片元数据；核对 hash、大小、维度及可信 object_key。也可通过已有授权上传 Token 调用上传 API，不额外签发无关凭据。
3. 若是从本次 Moondream 准备切换，复用同一 photo_id，但投递 **v2**；不要删除 v1 行或清除旧提交标记。检查 v2 是否已存在：succeeded 则复用，running/needs_review 则先核查，不重新调用。
4. 启动 `wrangler tail --env dev --format json` 后投递一次 `{photo_id, analysis_version:"v2"}`。当前 Wrangler 无 Queues publish 子命令，可用授权管理 API：`POST /client/v4/accounts/{account_id}/queues/{queue_id}/messages`，body 为 `{ "body": { "photo_id": "...", "analysis_version": "v2" }, "content_type": "json" }`，不是二次编码字符串。投递前保存检查点，发送响应丢失先查 D1/Queue，不用新UUID重试。
- **尾日志就绪判断**：当前 Wrangler 的 `--format json` 不打印 `Connected to`，不能等待这个不存在的提示。若要严格确认连接，可用 pretty 模式观察，或按锁定 Wrangler 的 tail 协议注册临时 tail 并等待 trace-v1 WebSocket open；连接URL含认证信息，只在内存使用，不输出或写入普通日志。结束时仅关闭本次订阅。

5. 管理 API 认证只在 Node 子进程内捕获 `wrangler auth token --json`（stdio: ignore/pipe/pipe），设 WRANGLER_WRITE_LOGS=false、WRANGLER_SEND_METRICS=false。只接受 oauth/api_token，在内存构造 Authorization，不打印 token、不读 OAuth 凭据文件、不新增高权限 Token。
6. 有界轮询这一 photo/v2 的分析状态，直到 succeeded、needs_review、failed 或等待结束。保存完整成功文本和 request ID 于受限检查点，向用户报告实际合成图描述，不伪造或用 mock 代替。
7. 复投同一已成功消息可验证幂等，不重新推理；确认 attempt_count、provider_attempt_id、request_id 和文本未改变。失败尤其超时/CPU中断时保留记录核查，不能清空标记盲重调；需要再次真实调用时解释原因与费用并另行确认。
8. 停止本次 tail，不停止其他会话。保留合成数据便于复查，不自动删桶、用户或分析行。

## 6. 日志、CPU 与费用

- dev 开启全采样 Workers Logs、持久化日志与 invocation logs，应用记录阶段 start/end、固定错误码、UUID、大小/结果长度；不记录图片、正文、凭据或底层错误。
- 模型推理/网络等待不等于 Worker CPU；Base64/JSON和日志仍耗CPU。应用wall_ms不能作为CPU计时，Workers同步代码期间时钟可能不前进。
- 模型调用应用超时45秒、lease120秒，Queue wall time上限15分钟；CPU配额按当前套餐和触发器官方规则核对。禁止自动修改 cpu_ms 或升级计划。
- CPU/内存强制终止不保证 catch/finally/最终日志。结合平台 CPU time、wall time、Exceeded CPU Time Limits / exceededCpu 与最后阶段；主动retry时平台可能仍为ok，需看message_retry。
- 即使某次 CPU 超过用户预期预算但 outcome=ok，也照实报告两者，不推断平台限额已改变、不伪称严格达标。小图成功不证明最大图片符合Free CPU预算。推理额度/费用与Worker CPU分开；只报告实测指标，拿不到CPU字段就记未取得，不使用Startup Time冒充。
- Free日志当前每天200,000条、保留3天；队列留存以实际配置为准。日志自身有开销，后续调采样须说明可能遗漏事件。

## 7. 交接

报告账号/dev、实际版本、AI/DB/PHOTOS和Queue绑定、迁移、真实photo/version/result、模型request ID、日志与可取得的CPU指标。本地检查、dry-run、部署成功、真实推理成功分别说明。更新应用 README 和 CLAUDE 的实际状态；未成功不能说目标完成。历史检查点和已使用账号不是下一次操作授权，不提交或推送除非用户要求。
