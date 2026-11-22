# LookMe 调试页

面向程序员的只读开发调试页。按用户选择照片或故事视图，侧栏可收起；照片使用等尺寸网格卡片，每页 24 张，摘要最多显示三行，详情弹窗保留完整摘要和元数据。图片下方显示实际选中的分析版本和状态，优先选成功分析，其次按更新时间选择。

照片日期与时间范围按 `captured_at_ms`（拍摄时间）筛选和排序，固定 UTC+8、包含结束分钟；不回退到上传时间，缺少拍摄时间的照片在侧栏单独计数。分页游标绑定用户、日期、时间段和拍摄时间口径；刷新或改筛选从第一页重新读取。故事没有持久化结果或历史查询接口，独立故事页明确显示这一状态，不调用生成模型。

照片留在私有 R2，页面经本 Worker 读取，不开放桶的公共访问。访问需要 `DEBUG_PASSWORD`：登录后发一个 HttpOnly、Secure、SameSite=Strict 的会话 Cookie，有效期 12 小时，口令不进入 Cookie、URL 或日志。未配置口令时返回 503，不会把照片公开。

本 Worker 只绑定 `DB` 与 `PHOTOS`，代码不写 D1、不改 R2。它与上传 Worker、图片转文字 Worker 相互独立，共用同一个开发数据库和照片桶。

```bash
npm ci
printf '%s' '口令' | npx wrangler secret put DEBUG_PASSWORD --env dev
npm run deploy:dev
```

部署前先核对 `wrangler.jsonc` 里的自定义域名没有指向其他 Worker。口令只通过 secret 注入，不写入仓库。
