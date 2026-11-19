# 多语言上传 smoke tests

此目录是可运行客户端，不是伪代码：

| 文件 | 运行环境 |
| --- | --- |
| `upload.sh` | Bash、curl（7.55+）、Python 3 |
| `upload.c` | C11、libcurl 开发库 |
| `upload.cpp` | C++17、libcurl 开发库；自动 UUID 模式需系统 uuidgen |
| `upload.mjs` | 支持原生 fetch/FormData 的 Node.js（建议使用项目 Node 环境） |
| `upload.py` | Python 3 标准库，无第三方依赖 |
| `CMakeLists.txt` | CMake 3.16+，生成 upload_c 和 upload_cpp |
| `verify.py` | 本地 mock 回归，构建并执行全部五种客户端 |

所有客户端只做一次请求，不自动重试。C++ 省略 CLIENT_PHOTO_ID 时调用系统 uuidgen 并在请求前输出；重试必须显式复用该 UUID。其他客户端仍要求显式提供 UUID。C++ 客户端省略 BASE_URL 时默认使用 `https://lookme-api-dev.sunnyhaoming.workers.dev`；其他客户端仍要求显式地址。所有客户端均无默认实际凭据。Token 从文件读取，不打印明文；默认收到 200/201 才退出 0，网络失败/其他状态退出非 0。设置 `EXPECT_STATUS` 后，仅状态与其一致才退出 0，方便测试 401/409/413/415 等失败路径。

## C/C++ 构建

从 `worker-cloudflare/` 执行：

```bash
cmake -S test/clients -B test/clients/build
cmake --build test/clients/build --config Release
```

需要安装本机 C/C++ 编译器、CMake 和 libcurl 开发库。CMake 使用 `find_package(CURL REQUIRED)`，不在线下载依赖。找不到 libcurl 时配置 `CMAKE_PREFIX_PATH` 或 CURL 的安装路径；静态 libcurl 可能需要平台相应的 TLS/压缩等传递依赖，优先使用本机可用的共享库。多配置生成器的二进制通常在 `build/Release/`。

不会自动注册访问远端的 CTest；构建本身不上传图片。

## 本地 mock 回归（默认推荐）

同样从 `worker-cloudflare/` 执行，需要上述全部工具以及 `npm ci` 安装的 jpeg-js：

```bash
python3 -I test/clients/verify.py
```

该命令自动：

1. 在临时目录用 CMake 构建 C/C++。
2. 生成合成 JPEG、本地夹具 Token，启动 127.0.0.1 上的临时 HTTP 服务。
3. 对每个客户端验证首传 201、幂等 200、冲突 409、未知 Token 401、非法 JPEG 415、超限 413，再验证 C++ 自动 UUID 和显式幂等重传，共 32 个请求。
4. 关闭服务，清理临时图像/凭据及构建目录。

这是**客户端传输与状态断言测试**；mock 不做真实 D1/R2 写入或完整 JPEG 解码，不替代 `npm test` 中的真实 Miniflare 集成测试。mock 中的 Token 不是线上用户凭据。命令不访问 Cloudflare。

## 对接本地 Worker 或已授权的开发服务

先启动 `npm run dev` 并准备本地用户凭据，或由管理员提供目标开发服务的用户 Token。**将 BASE_URL 改成公网服务会真实写入数据，需事先获得授权。** 不要使用真实个人照片做默认测试。

```bash
export BASE_URL='http://localhost:8787'
export TOKEN_FILE='/受限目录/local-user.token'
export IMAGE_FILE='./processed.jpg'
export CLIENT_PHOTO_ID="$(uuidgen)"  # 首次逻辑上传生成一次并保存；重试不重新生成。
unset EXPECT_STATUS                # 默认接受 200 或 201。

bash test/clients/upload.sh
node test/clients/upload.mjs
python3 -I test/clients/upload.py

test/clients/build/upload_c "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
test/clients/build/upload_cpp "$BASE_URL" "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
```

这五次调用使用同一用户、UUID 和 JPEG：首个成功请求通常 201，其余应 200。每次响应中的 photo_id 应相同。C 使用四个位置参数；C++ 使用 `[BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]`，以 http:// 或 https:// 开头的首个参数识别为服务地址；其余为文件路径及可选 UUID。其他客户端使用环境变量。环境变量只承载凭据文件路径，不承载 Token 明文。

精确断言幂等重传：

```bash
EXPECT_STATUS=200 node test/clients/upload.mjs
```

负向测试需要提前确认原照片已上传；保持 UUID，但换成另一张合法 JPEG 后断言冲突：

```bash
EXPECT_STATUS=409 IMAGE_FILE='./different.jpg' bash test/clients/upload.sh
```

不会自动撤销/停用真实用户；生命周期测试需管理员单独授权。勿启用 shell tracing、curl verbose、TLS 校验绕过或重定向跟随。服务端目前只支持 POST /photos，无跨域浏览器 CORS 和图片下载接口。

完整字段、大小限制、幂等和错误码见 [USAGE.md](../../USAGE.md)。这些客户端固定 `source=cli`，不提交可选拍摄时间。C/C++ 验证 HTTP 状态并输出响应；JS/Python 输出 JSON，非 JSON 平台响应不应被当作成功业务结果。精确 JSON、photo_id 相等及实际存储结果应由集成测试核对，而非仅凭退出码推断。

查看 C++ 参数说明：`test/clients/build/upload_cpp --help`。使用默认线上地址：

```bash
test/clients/build/upload_cpp "$TOKEN_FILE" "$IMAGE_FILE" "$CLIENT_PHOTO_ID"
```

该三参数调用会真实上传到开发服务；本地测试应继续显式提供 `http://localhost:8787`。

## C++ 自动 UUID 与成功摘要

```bash
# 默认开发服务，自动调用 uuidgen；会真实上传。
test/clients/build/upload_cpp "$TOKEN_FILE" "$IMAGE_FILE"

# 本地服务，自动 UUID。
test/clients/build/upload_cpp 'http://localhost:8787' "$TOKEN_FILE" "$IMAGE_FILE"
```

程序会在请求前打印 `CLIENT_PHOTO_ID=...`，包括之后网络失败的情况。请保存该值，重试时显式补上；每次省略都会生成新的幂等键，可能产生重复照片。没有 uuidgen 时可安装本机对应工具（Linux 通常由 uuid-runtime 等包提供），或手动传入已生成 UUID。帮助模式不调用 uuidgen。无效 UUID（例如 `1`）会在网络请求前被拒绝。

成功后显示服务端原始 JSON（含 photo_id、uploaded_at）、HTTP 状态、是否幂等重传、文件绝对路径、字节数/KiB、JPEG 上传类型、请求地址、总耗时和平均上传速度。耗时包含连接、发送及服务端响应；速度由 libcurl 统计，单位 KiB/s，包含 multipart 开销，不等同于纯 JPEG 吞吐率。文件路径可能包含个人目录名，只应保留在用户自己的日志中，不输出 Token。
