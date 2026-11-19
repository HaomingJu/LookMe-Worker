# 多语言上传 smoke tests

本目录包含可运行的 curl/Bash、C、C++、JavaScript/Node.js 和 Python 客户端，参数及成功摘要保持一致。

| 文件 | 运行环境 |
| --- | --- |
| `upload.sh` | Bash、curl 7.55+、Python 3；自动 UUID 需 uuidgen |
| `upload.c` | C11、libcurl 开发库；自动 UUID 需 uuidgen |
| `upload.cpp` | C++17、libcurl 开发库；自动 UUID 需 uuidgen |
| `upload.mjs` | 支持原生 fetch/FormData 的 Node.js；使用 crypto.randomUUID() |
| `upload.py` | Python 3 标准库；使用 uuid.uuid4()，无需第三方依赖 |
| `CMakeLists.txt` | CMake 3.16+，构建 upload_c / upload_cpp |
| `verify.py` | 构建五种客户端并执行本地 mock 回归 |

## 统一参数与帮助

所有客户端均支持：

```text
程序 [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]
程序 --help
```

- BASE_URL 可选，默认 `https://lookme-api-dev.sunnyhaoming.workers.dev`；首个参数以 http:// 或 https:// 开头时识别为地址，程序追加 `/photos`。
- TOKEN_FILE 是凭据文件路径，不是明文 Token；没有默认 Token。
- JPEG_FILE 是已处理的 JPEG 路径，服务端要求非空、≤ 2 MiB，宽高均 ≤ 2048 px，整个 multipart ≤ 3 MiB。
- CLIENT_PHOTO_ID 可选，省略时自动生成 UUID，并在读取凭据/发送请求之前打印 `CLIENT_PHOTO_ID=...`。**保存此值；失败重试必须显式复用，不能每次省略。**
- EXPECT_STATUS 是可选环境变量，默认接受 200/201；设置时仅状态与指定值一致才退出 0。

C/C++/Bash 调用系统 uuidgen，Python/JS 使用语言内置 UUIDv4 生成器。没有 uuidgen 时，安装对应本机工具或显式传入 UUID。无效 UUID（如 `1`）在请求前被拒绝。

所有客户端只做一次请求，不自动重试。`--help` 不生成 UUID、不读 Token、不访问服务；会显示默认地址、参数、JPEG 限制及统计口径。

## C/C++ 构建

从 `worker-cloudflare/` 执行：

```bash
cmake -S test/clients -B test/clients/build
cmake --build test/clients/build --config Release
```

需要本机 C/C++ 编译器、CMake 和 libcurl 开发库。CMake 使用 `find_package(CURL REQUIRED)`，不在线下载依赖。多配置生成器的二进制通常在 `build/Release/`。找不到库时配置 CMAKE_PREFIX_PATH 或 CURL 安装路径；静态 libcurl 可能需要 TLS/压缩等传递依赖，优先使用可用的共享库。

构建不上传，不自动注册会访问远端的 CTest。

## 调用示例

**以下默认地址会真实写入开发 D1/R2；真实上传前须获得授权。** Token/图片路径替换为本机文件。首次省略 UUID：

```bash
test/clients/build/upload_c '/受限目录/用户.token' './processed.jpg'
test/clients/build/upload_cpp '/受限目录/用户.token' './processed.jpg'
node test/clients/upload.mjs '/受限目录/用户.token' './processed.jpg'
python3 -I test/clients/upload.py '/受限目录/用户.token' './processed.jpg'
bash test/clients/upload.sh '/受限目录/用户.token' './processed.jpg'
```

每次省略都会新生成 UUID；不要把以上五次独立执行误当成同一照片的幂等重传。跨语言重试必须把同一个 UUID 显式传给所有客户端。

本地服务、显式 UUID：

```bash
export BASE_URL='http://localhost:8787'
export TOKEN_FILE='/受限目录/local-user.token'
export IMAGE_FILE='./processed.jpg'
export CLIENT_PHOTO_ID="$(uuidgen)"  # 首次生成一次并保存；重试不重新生成。
unset EXPECT_STATUS

test/clients/build/upload_c "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
test/clients/build/upload_cpp "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
node test/clients/upload.mjs "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
python3 -I test/clients/upload.py "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
bash test/clients/upload.sh "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
```

同用户、同 UUID、同 JPEG 的五次调用首个成功请求通常 201，后续应 200，photo_id 一致。先完成本地迁移/用户签发并启动 `npm run dev`。

Python/JS/Bash 保留无位置参数的环境变量模式：

```bash
node test/clients/upload.mjs
python3 -I test/clients/upload.py
bash test/clients/upload.sh
```

环境变量模式使用 TOKEN_FILE、IMAGE_FILE 及可选 BASE_URL/CLIENT_PHOTO_ID；位置参数模式忽略这些配置环境变量，只有 EXPECT_STATUS 仍生效。例如 `EXPECT_STATUS=200 node test/clients/upload.mjs` 可精确断言环境变量模式的重传。Token 明文始终只从文件读取，不进入命令参数。

## 成功摘要与速度口径

每种客户端成功后都显示：

- 服务端原始响应，含 photo_id、uploaded_at。
- HTTP 状态、首次保存/幂等重传。
- 文件绝对路径、字节数与 KiB、JPEG 上传类型、目标地址。
- 请求耗时（含连接、上传及服务端响应）。
- 平均上传速度（KiB/s）。

**C/C++/curl** 使用 libcurl/curl 上传速率，包含 multipart 开销；**Python/JS** 使用 JPEG 字节数 ÷ 整体请求耗时，是端到端有效平均速率，包含连接及服务端处理，不是纯网络带宽。两者不能直接作为同口径性能比较。

文件路径可能包含个人目录名，仅保留在用户自己的日志中。不得输出 Token、开启 shell tracing/curl verbose、绕过 TLS 校验或自动跟随重定向。统计摘要不解析/确认 JPEG 的实际内容；真实格式由服务端校验。

## 本地 mock 回归

从 Worker 目录执行（需要上述工具和 `npm ci` 安装的 jpeg-js）：

```bash
npm run test:clients
```

自动在临时目录构建 C/C++、生成合成 JPEG/夹具 Token，启动 127.0.0.1 临时服务；五语言分别验证 201/200/409/401/415/413，自动 UUID 与显式重传，共 40 个请求，另检查帮助、默认参数、UUID 拒绝及统计摘要；最后关闭服务、清理临时凭据和构建。

这是客户端传输与状态断言测试，mock 不做真实 D1/R2 写入或完整 JPEG 解码，不替代 `npm test` 的 Miniflare 集成测试。没有远端请求，不使用实际用户 Token。

负向和生命周期测试须先明确授权，不自动撤销/停用真实用户。完整协议见 [USAGE.md](../../USAGE.md)。客户端固定 source=cli，不提交可选拍摄时间；精确 JSON、photo_id 相等及实际存储状态由集成测试核对，不仅凭退出码推断。

## 加速多张照片：C++ 批量客户端

新增 `upload_batch_cpp`，同一进程最多并发 **8 张**，复用连接，每张独立UUID，自动创建本地受限状态文件，输出 STATE_FILE，恢复时用 --state 指定原文件并跳过已成功照片。构建、首次上传/恢复命令和限制见 [BATCH.md](BATCH.md)；本地验证：`npm run test:batch`。默认域名为已配置的 `https://api.fudaixuexue.eu.cc`，不修改旧单张客户端。
