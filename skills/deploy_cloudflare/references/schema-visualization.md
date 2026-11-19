# Schema 可视化

唯一数据源是本目录的 `schema.sql`。生成文件不要手工编辑：

- `schema.mmd`：Mermaid ER 图源码，可用支持 Mermaid 的编辑器预览。
- `schema.html`：无需 CDN、网络或服务器的 HTML 页面，直接在浏览器打开；包含关系图、字段、复合唯一键、原始 CHECK 约束和索引。

从仓库根目录执行（需要 Python 3，仅使用标准库）：

```bash
python3 -I skills/deploy_cloudflare/scripts/generate_schema.py
```

开发时保持监听进程运行，保存 schema 即重新生成两个文件：

```bash
python3 -I skills/deploy_cloudflare/scripts/generate_schema.py --watch
```

HTML 是静态输出，已经打开的浏览器标签需刷新。监听遇到 SQL 错误时保留上次输出并报告错误。退出后不会继续监听。

脚本根据自身路径定位默认 schema，不依赖启动目录、Cloudflare 账号或秘密。自定义数据源使用 `--schema /path/to/schema.sql`，输出位于该文件旁边。

通过 SQLite 内存数据库解析表结构、外键和唯一键；不会连接 Cloudflare 或修改现有数据库。输入应为可信的建表 SQL，不是任意外部下载脚本；Mermaid 表/字段名限字母、数字和下划线。图中的 cardinality 来自外键字段空值和唯一约束，不代表所有应用层业务规则。复合唯一键在 HTML 中完整列出，Mermaid 的 UK 仅标记单字段唯一键。

修改 schema 后，应重新生成并一起保存两个输出。此可视化不自动修改版本化迁移，不表示远端 schema 已同步。
