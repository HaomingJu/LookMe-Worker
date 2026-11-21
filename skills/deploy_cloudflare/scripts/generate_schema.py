"""从 SQLite schema 生成 ER 图和离线 HTML；只操作内存数据库。"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import sqlite3
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'references/schema.sql'


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def generate(source):
    sql = source.read_text()
    digest = hashlib.sha256(sql.encode()).hexdigest()
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(sql)
    tables = []
    relations = []
    for name, definition in db.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
            raise ValueError(f'Mermaid 不支持此表名：{name}')
        columns = list(db.execute(f'PRAGMA table_info({quote(name)})'))
        unique = []
        indexes = []
        for idx in list(db.execute(f'PRAGMA index_list({quote(name)})')):
            fields = tuple(row[2] for row in db.execute(f'PRAGMA index_info({quote(idx[1])})'))
            if idx[2]:
                unique.append(fields)
            index_sql = db.execute('SELECT sql FROM sqlite_master WHERE name=?', (idx[1],)).fetchone()[0]
            if index_sql:
                indexes.append(index_sql)
        pk = tuple(c[1] for c in sorted(columns, key=lambda c: c[5]) if c[5])
        if pk and pk not in unique:
            unique.append(pk)
        grouped = {}
        for fk in db.execute(f'PRAGMA foreign_key_list({quote(name)})'):
            grouped.setdefault(fk[0], []).append(fk)
        foreign_columns = set()
        for rows in grouped.values():
            rows.sort(key=lambda r: r[1])
            child = tuple(r[3] for r in rows)
            parent = tuple(r[4] for r in rows)
            foreign_columns.update(child)
            nullable = any(not c[3] for c in columns if c[1] in child)
            single = any(set(key).issubset(child) for key in unique)
            relations.append(dict(parent=rows[0][2], child=name, fields=child,
                                  targets=parent, delete=rows[0][6], nullable=nullable, single=single))
        tables.append(dict(name=name, sql=definition, columns=columns, unique=unique,
                           indexes=indexes, foreign=foreign_columns))
    db.close()
    er = ['erDiagram']
    for table in tables:
        er.append(f'    {table["name"]} {{')
        for _, name, kind, required, default, pk in table['columns']:
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                raise ValueError(f'Mermaid 不支持此字段名：{name}')
            keys = []
            if pk:
                keys.append('PK')
            if name in table['foreign']:
                keys.append('FK')
            if (name,) in table['unique']:
                keys.append('UK')
            er.append(f'        {re.sub(r"[^A-Za-z0-9_]", "_", kind) or "ANY"} {name}' + (' ' + ','.join(keys) if keys else '') + (' "NOT NULL"' if required else ' "nullable"'))
        er.append('    }')
    for r in relations:
        parent_end = '|o' if r['nullable'] else '||'
        child_end = 'o|' if r['single'] else 'o{'
        label = ', '.join(r['fields']) + ' / DELETE ' + r['delete']
        er.append(f'    {r["parent"]} {parent_end}..{child_end} {r["child"]} : "{label}"')
    mermaid = '\n'.join(er) + '\n'
    esc = html.escape
    cards = []
    for t in tables:
        rows = []
        for _, name, kind, required, default, pk in t['columns']:
            tags = ('PK ' if pk else '') + ('FK ' if name in t['foreign'] else '') + ('UK' if (name,) in t['unique'] else '')
            rows.append(f'<tr><td><code>{esc(name)}</code></td><td>{esc(kind)}</td><td>{tags}</td><td>{"必填" if required else "可空"}</td><td><code>{esc(str(default)) if default is not None else "—"}</code></td></tr>')
        constraints = ''.join(f'<li><code>UNIQUE / PK ({esc(", ".join(key))})</code></li>' for key in t['unique'])
        indexes = '\n'.join(t['indexes'])
        cards.append(f'<section id="{t["name"]}"><h2>{t["name"]}</h2><div class="scroll"><table><thead><tr><th>字段</th><th>类型</th><th>键</th><th>空值</th><th>默认值</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div><h3>唯一键（含复合键）</h3><ul>{constraints}</ul><details><summary>完整表定义与索引 · 含 CHECK 约束</summary><pre>{esc(t["sql"])};\n{esc(indexes)}</pre></details></section>')
    figures = []
    for i, r in enumerate(relations):
        label = f'{r["parent"]} → {r["child"]}'
        caption = f'({", ".join(r["fields"])}) → ({", ".join(r["targets"])})；ON DELETE {r["delete"]}。每个父记录对应 ' + ('0–1' if r['single'] else '0–N') + ' 个子记录；每个子记录对应 ' + ('0–1' if r['nullable'] else '1') + ' 个父记录。'
        figures.append(f'<figure><svg viewBox="0 0 680 100" role="img" aria-label="{esc(label)}"><defs><marker id="arrow{i}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="currentColor"/></marker></defs><rect x="4" y="20" width="230" height="56" rx="4"/><rect x="446" y="20" width="230" height="56" rx="4"/><text x="119" y="53" text-anchor="middle">{r["parent"]}</text><text x="561" y="53" text-anchor="middle">{r["child"]}</text><path d="M234 48 H440" marker-end="url(#arrow{i})"/><text x="340" y="32" text-anchor="middle">关联 0–{"1" if r["single"] else "N"} 条</text></svg><figcaption>{esc(caption)}</figcaption></figure>')
    page = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="claude:viewport-fit-sides" content="cover"><title>LookMe 数据关系</title>
<style>
/* 关系总览在前，表结构与原始约束按表展开。 */
:root{--bg:#f4f7fa;--fg:#20354a;--surface:#fff;--muted:#536b80;--line:#cfdae4;--accent:#126b80;--display:Georgia,'Songti SC',serif;--body:system-ui,'PingFang SC',sans-serif;--code:ui-monospace,Menlo,monospace;color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14212d;--fg:#e0eaf2;--surface:#1d2e3e;--muted:#a3b8ca;--line:#3a5063;--accent:#7bcddd;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#14212d;--fg:#e0eaf2;--surface:#1d2e3e;--muted:#a3b8ca;--line:#3a5063;--accent:#7bcddd;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 var(--body);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:32px}main{max-width:1060px;margin:auto;display:grid;gap:24px;min-width:0}h1{font:600 32px var(--display);text-wrap:balance}h2{font:600 22px var(--code)}h3{font-size:16px}p,figcaption{color:var(--muted)}code,pre{font:14px/1.6 var(--code)}section{min-width:0;border-top:1px solid var(--line);padding-block:16px}nav{display:flex;gap:16px;flex-wrap:wrap}a,summary{color:var(--accent)}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.scroll,pre{overflow-x:auto;max-width:100%}table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}th,td{padding:10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted)}figure{margin:0 0 20px;background:var(--surface);padding:16px;border:1px solid var(--line)}svg{display:block;width:100%;height:auto;max-width:100%;color:var(--fg)}svg rect{fill:var(--surface);stroke:var(--line)}svg path{stroke:currentColor;fill:none}svg marker path{fill:currentColor}svg text{fill:currentColor;font:14px var(--code)}summary{cursor:pointer}pre{background:var(--surface);padding:16px}footer{font-size:13px;color:var(--muted);overflow-wrap:anywhere}ul{padding-left:22px}
</style></head><body><main>'''
    navigation = ''.join(f'<a href="#{t["name"]}">{t["name"]}</a>' for t in tables)
    page += f'<header><h1>LookMe 数据关系</h1><p>由 {esc(source.name)} 自动生成。字段与关系来自 SQLite 内存数据库解析，不连接 Cloudflare。</p><nav>{navigation}</nav></header>'
    page += '<section><h2>外键关系</h2>' + ''.join(figures) + '<p>PK = 主键；FK = 外键；UK = 单字段唯一键。复合唯一键见各表明细。箭头从被引用表指向引用表，不表示数据传输方向。</p><p>图只展示数据库约束，不推断业务要求。当前 Demo 的“恰好 3 张不同照片”需要 API 校验；position 范围与唯一键不能单独保证数量。</p></section>'
    page += ''.join(cards) + f'<section><h2>Mermaid ER 源码</h2><pre>{esc(mermaid)}</pre></section><footer>来源 SHA-256：{digest}<br>修改 schema.sql 后运行生成命令，或使用 --watch 自动重新生成。本页面为静态快照，已打开的页面需刷新；此工具不修改迁移或远端数据库。</footer></main></body></html>\n'
    source.with_suffix('.mmd').write_text(mermaid)
    source.with_suffix('.html').write_text(page)
    print(f'已生成 {source.with_suffix(".mmd")} 和 {source.with_suffix(".html")}')
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--schema', type=Path, default=SOURCE)
    parser.add_argument('--watch', action='store_true', help='监听 schema 内容变化并重新生成')
    args = parser.parse_args()
    previous = generate(args.schema)
    if args.watch:
        print('正在监听 schema；按 Ctrl+C 退出。', flush=True)
        try:
            while True:
                time.sleep(1)
                current = hashlib.sha256(args.schema.read_bytes()).hexdigest()
                if current != previous:
                    try:
                        generate(args.schema)
                    except (sqlite3.Error, ValueError) as error:
                        print(f'生成失败，保留上次输出：{error}', flush=True)
                    previous = current
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
