# C++ 批量上传

`upload_batch_cpp` 在同一进程使用 libcurl multi 连接池，每张照片仍调用单张 `POST /photos`，最多同时执行 **8 个请求**。不改 Worker API，不共用照片 UUID，不自动无限重试。

## 构建

从 `worker-cloudflare/`：

```bash
cmake -S test/clients -B test/clients/build
cmake --build test/clients/build --config Release --target upload_batch_cpp
test/clients/build/upload_batch_cpp --help
```

依赖 C++17、libcurl 和系统 uuidgen。多配置生成器的二进制在 `build/Release/`。现有 upload_c/upload_cpp 等单张客户端不受影响。

## 首次上传

```text
upload_batch_cpp [BASE_URL] TOKEN_FILE JPEG_FILE...
```

- 默认 Base URL 为 `https://api.fudaixuexue.eu.cc`，也可显式指定本地/其他地址；此默认不同于旧单张客户端的 workers.dev 默认值。
- Token 从文件读取，不在状态或普通输出中保存明文。
- 首次不用提供 STATE_FILE：客户端在用户主目录的 `.lookme-upload-batches/` 自动创建唯一的 `batch-UUID.upload-state` 文件，请求前输出 `STATE_FILE=完整路径`。新建目录在 POSIX 上为0700，文件为0600；已有目录若不受限会拒绝，不自动修改其权限。Windows 使用 USERPROFILE 下的目录及ACL，尚未实机验证。
- 可用 `--state STATE_FILE` 自选状态或恢复；显式路径的父目录仍需预先存在并受限。原来以 `.upload-state` 命名的位置参数兼容，其他文件名必须用 --state。
- JPEG_FILE 为一个或多个明确的文件路径，不支持传入目录；通配符可由 shell 展开。批次拒绝重复路径。
- 本地先验证非空、≤ 2 MiB；实际 JPEG/尺寸仍由服务端验证，每边 ≤2048px。上传前处理好方向、sRGB、压缩和隐私元数据。

下面示例会真实上传到开发服务，仅对已获授权的图片执行：

```bash
test/clients/build/upload_batch_cpp \
  'https://api.fudaixuexue.eu.cc' \
  '/受限目录/用户.token' \
  './photo-a.jpg' './photo-b.jpg' './photo-c.jpg'
```

无需手工创建目录，运行前保存所有照片UUID，发送请求前输出 STATE_FILE；请保存此路径。再次不带 --state 运行相同图片会创建新的独立批次，不是重试。工具显示单张状态、原始服务响应（含 photo_id）、大小、耗时、libcurl 上传速度，以及批次总耗时和有效速率。

## 失败/中断后恢复

```bash
test/clients/build/upload_batch_cpp \
  --state '/上次输出的完整路径/batch-UUID.upload-state' \
  'https://api.fudaixuexue.eu.cc' \
  '/受限目录/用户.token'
```

恢复行为：

- 成功（200/201）的照片跳过；失败/未确认的照片再次使用原 UUID。
- 全部已成功时不会发送任何上传请求。
- 每次运行只尝试每张一次；401/409/413/415 等应先解决原因，不能把恢复当作无限循环。
- 服务地址和规范化 Token 文件路径必须与原批次一致。Token 轮换必须仍属于同一用户；工具只绑定路径，不查询用户身份，不能换成其他用户的 Token 来恢复。
- 所有原始文件必须保留，大小和修改时间一致；恢复不会重新压缩，也不会为修改过的文件自动生成新 UUID。这是本地元数据检查，不是文件内容哈希校验；服务端仍按 SHA-256 校验实际字节。
- 图片改变或需重新处理时，创建**只包含改过/新的图片**的新批次；不要把已成功图片重新加到新批次造成重复记录。

SIGINT/SIGTERM（包括 Ctrl+C）会取消活跃请求并释放批次锁；可能已被服务端接受的请求在恢复时通过同一 UUID 幂等收敛。SIGKILL、断电等可能留下 `<STATE_FILE>.lock` 或 `.tmp`。先确认没有进程使用，再检查并手动处理这些残留；工具不会擅自删除不明锁或临时状态。

状态是带版本的 quoted-text 格式，包含服务地址、凭据文件路径、图片路径、UUID、大小、修改时间、HTTP状态和响应。不手工编辑、不公开、不提交 Git；它不是远端事务或云端备份。

## 连接复用与统计

- 最多8个活跃请求/主机连接；同一批次中完成请求的连接留在 multi 池中供后续图片复用。HTTP/2 若可用可能复用更少连接，不保证所有网络都支持。
- `发送进度` 表示请求体已发送比例，**不表示 R2/D1 已保存成功**；只有200/201计为成功。
- 单张速度来自 libcurl，包含 multipart 开销；批次有效速率为本次成功文件字节数÷批次耗时（含服务端处理），跳过的历史成功文件不计入本次吞吐率。
- 8并发可能提升整批吞吐，也可能争用带宽/服务端资源；不能保证单张更快，不取消JPEG验证、D1鉴权或套餐限制。
- 若本机需要代理，使用既有 HTTPS_PROXY 等 libcurl 环境变量；不自动读取或修改系统代理。连接池只能减少重复建连，不能修复不可达的DNS/TLS路径。

## 本地验收

```bash
npm run test:batch
```

用临时 HTTP/1.1 服务和12张合成JPEG检查：最大8并发、连接复用、部分失败恢复、稳定UUID、跳过已成功照片、权限/文件变化/锁保护及中断恢复。无远端请求；mock不验证真实D1/R2或完整JPEG解码。真实存储行为仍由原 `npm test` 验证。

真实上传返回0表示本批次全部确认成功；返回1表示部分失败或未确认。恢复必须用 --state 指定原状态文件，不能为同一失败批次重新创建一组UUID。

## 其他语言的独立批量实现

以下不是 C++ 包装器，各自运行独立的网络调度：

| 程序 | 传输与连接复用 | 依赖 |
| --- | --- | --- |
| `upload_batch_c` | 原生C/libcurl multi，最多8请求/连接 | C11、libcurl、uuidgen，CMake构建 |
| `upload_batch.mjs` | Node undici连接池，8个异步任务 | Node及 `npm ci` 安装的undici，不需要CMake |
| `upload_batch.py` | 8线程，线程内持久HTTP/HTTPS连接 | Python3标准库，不需要CMake |
| `upload_batch.sh` | 单个curl parallel进程，最多8传输 | curl7.75+、Bash、Python3；Python仅管理状态/配置，不调用C++ |

C构建：

```bash
cmake --build test/clients/build --config Release --target upload_batch_c
```

首次调用（默认开发域，会真实写入，先确认图片授权）：

```bash
test/clients/build/upload_batch_c '/受限目录/用户.token' ./photo-a.jpg ./photo-b.jpg
node test/clients/upload_batch.mjs '/受限目录/用户.token' ./photo-a.jpg ./photo-b.jpg
python3 -I test/clients/upload_batch.py '/受限目录/用户.token' ./photo-a.jpg ./photo-b.jpg
bash test/clients/upload_batch.sh '/受限目录/用户.token' ./photo-a.jpg ./photo-b.jpg
```

需要本地地址时放在Token路径前。每个程序都支持 `--help`、自动创建状态和 `--state` 恢复，例如：

```bash
node test/clients/upload_batch.mjs --state '/上次输出/js-batch-UUID.upload-state' '/受限目录/用户.token'
python3 -I test/clients/upload_batch.py --state '/上次输出/py-batch-UUID.upload-state' '/受限目录/用户.token'
bash test/clients/upload_batch.sh --state '/上次输出/curl-batch-UUID.upload-state' '/受限目录/用户.token'
test/clients/build/upload_batch_c --state '/上次输出/c-batch-UUID.upload-state' '/受限目录/用户.token'
```

状态格式：
- Python、JS、curl 使用 `LOOKME_NATIVE_BATCH_V1` JSON，可在同一机器/用户/服务/Token文件路径下跨这三种客户端恢复。
- C使用 `LOOKME_C_BATCH_V1`，C++使用 `LOOKME_BATCH_V1`；两者与脚本状态格式不同，不能混用。
- 不自动转换状态，不通过重新生成UUID“恢复”。全部路径、大小和修改时间检查仍生效。

每张的状态/响应/大小/耗时/速率和批次成功数都会显示。C/curl统计真实libcurl上传速率（含multipart）；Python/JS是端到端有效速率（含服务端处理），不是纯网络带宽，也不适合直接同口径横向比较。

C/curl/JS支持代理环境变量；Python持久连接目前支持HTTP代理的CONNECT，未实现SOCKS/HTTPS代理转发。Python中断停止继续调度，但正在进行的阻塞请求需等待响应/超时收尾；Node使用取消信号中断请求。任何在途请求都可能已被服务端接受，应通过原UUID恢复确认。

完整原生批量验收：

```bash
npm run test:batch:all
# 单独运行，不依赖其他客户端构建：
python3 -I test/clients/verify_batch.py --language python
python3 -I test/clients/verify_batch.py --language js
python3 -I test/clients/verify_batch.py --language curl
python3 -I test/clients/verify_batch.py --language c
```

这些检查仅用本地合成图。跨平台行为尤其Windows尚未实机验证。
