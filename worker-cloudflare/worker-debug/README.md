# LookMe 调试页

面向程序员的只读开发调试页。按用户选择照片、故事或漫画视图，侧栏可收起；照片使用等尺寸网格卡片，每页 24 张，摘要最多显示三行，详情弹窗保留完整摘要和元数据。图片下方显示实际选中的分析版本和状态，优先选成功分析，其次按更新时间选择。

照片日期与时间范围按 `captured_at_ms`（拍摄时间）筛选和排序，固定 UTC+8、包含结束分钟；缺拍摄时间的照片在侧栏单独计数。照片默认**显示全部**（日期留空），主动选日期/时间段后才过滤，可用「重置」清除筛选。照片每页 24 张（4×6），底部显示「共 N 张 · M 页」与页码/跳页控件。故事视图通过D1查询生成批次与故事，按story_date（生成时指定的上传日）筛选，明确区别于照片拍摄日期。故事和漫画都按历史批次读取：故事每页10个批次，漫画每页10条记录，按生成时间倒序排列，可加载更多。

照片留在私有 R2，页面经本 Worker 读取，不开放桶的公共访问。访问需要 `DEBUG_PASSWORD`：登录后发一个 HttpOnly、Secure、SameSite=Strict 的会话 Cookie，有效期 12 小时，口令不进入 Cookie、URL 或日志。未配置口令时返回 503，不会把照片公开。

本 Worker 只绑定 `DB`、`PHOTOS` 与私有 `COMICS`，代码不写 D1、不改 R2。它与上传 Worker、图片转文字 Worker 相互独立，共用同一个开发数据库和照片桶。

```bash
npm ci
printf '%s' '口令' | npx wrangler secret put DEBUG_PASSWORD --env dev
npm run deploy:dev
```

部署前先核对 `wrangler.jsonc` 里的自定义域名没有指向其他 Worker。口令只通过 secret 注入，不写入仓库。

## 故事/漫画视图（0005/0006已迁移并部署）

选择用户 → 故事 → 上传日期，可查看每次生成的批次、状态、每日总结，以及模型/版本、输入快照时间、token用量、生成处理和模型耗时、官方单价及估算费用。费用明确标为估算非账单，缺失值为未知而非0；生成处理耗时截至结果落库前，不含CLI网络时间。

- `GET /api/stories?user=USER&date=YYYY-MM-DD[&cursor=...]`：按用户/上传日列出批次，每页10条，不返回输入摘要和profile私密快照。
- `GET /api/story?user=USER&run_id=UUID`：读取完整成功结果，包含story_id、四格分镜、来源UUID、提示词和coverage。
- `user` 参数可为用户名（大小写不敏感）或 user_id；侧栏用户列表直接显示用户名，未命名用户回退显示 user_id。点击用户名展开「照片 / 故事 / 漫画」三个视图，再次点击收起。
- 两个接口均使用现有DEBUG_PASSWORD会话鉴权，限制owner/run_id，支持ETag。该口令为管理员只读权限，并非每用户独立登录；有口令的人可查看列表中的所有用户。
- 状态generating长期停留需人工核查，不保证任务还在运行；needs_review显示错误码。不会重试模型或提供写库入口。
- 故事和模型文字通过textContent渲染，不执行HTML/脚本；切换用户、筛选、退出或会话失效会清理旧内容与请求。
- 迁移唯一来源为 `../worker-upload/migrations/0005_story_runs.sql`，先迁移再部署story/debug。站点本身不执行迁移，不读取本机故事JSON、不导入历史文件。

本地验收：`npm run typecheck`、`npm test`（真实本地D1后端测试 + Playwright浏览器测试）、`npm run build`（dry-run）。测试涵盖分页、身份过滤、XSS、移动端换行、错误重试及异步切换隔离。

## 漫画视图

选择用户 → 漫画 → 上传日期，可只读查看该用户成功的漫画结果（标题、摘要、模型、尺寸、图片）。漫画按 `story_runs.story_date`（生成故事时指定的上传日）分组，只展示 `status='succeeded'` 的结果，不触发模型。

- `GET /api/comics?user=USER&date=YYYY-MM-DD[&cursor=...]`：按用户/上传日列出漫画，每页10条。
- `GET /comic/{run_id}?user=USER`：读取漫画图片，从私有 `COMICS` 桶读取，受会话鉴权与 owner 约束。
- 调试页已绑定私有 `COMICS` 桶（`lookme-dev-comics`），只读，不写入、不生成。

2026-11-23发布：`lookme-debug-dev` 版本 `4aa1f50e-573a-490e-9492-acdc3cf4b19b`，地址 https://lookme.fudaixuexue.eu.cc 。共用0005迁移已应用，页面200及故事接口未登录401检查通过；保持原密码。部署步骤未执行模型调用；之后另经授权由story/Qwen生成并保存了3个故事，D1一致性已核对。历史文件未导入，登录后的远端网站读取未实测（本地链路已通过）。选择对应用户和2026-11-21上传日查看。

### 故事显示精简（本地修改，待部署）

网站不再渲染“完整输入…分镜引用…未引用UUID清单”段落；D1与API JSON中的coverage原信息保持不变。每个故事默认折叠，只显示标题，点击标题或使用键盘Enter/空格可展开、收起完整正文与四格提示词。批次中的故事列表也可整体展开/收起；反复切换只使用当前页面已加载的数据，不重新请求、不生成故事。模型、耗时、用量、费用等批次信息保留。
