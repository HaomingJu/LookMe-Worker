# 图像上传 API 对接

本文供客户端开发者及其他 AI 对接已实现的 `POST /photos`。仅描述当前代码，不把规划中的建单、查询、漫画生成和下载接口视为可用功能。

## 1. 接入前提

| 项目 | 内容 |
| --- | --- |
| 开发环境自定义 Base URL | `https://api.fudaixuexue.eu.cc` |
| 兼容 workers.dev 地址 | `https://lookme-api-dev.sunnyhaoming.workers.dev` |
| 本地 Base URL | `http://localhost:8787`（以 Wrangler 输出为准） |
| 上传路径 | `/photos` |
| 方法 | `POST` |
| 编码 | `multipart/form-data`，文件二进制，不用 JSON/Base64 |
| 认证 | `Authorization: Bearer <独立用户Token>` |

当前测试客户端内置默认值仍为 workers.dev；测试自定义域请显式传入 `https://api.fudaixuexue.eu.cc` 或设置 BASE_URL。两者访问同一个 Worker，使用同一用户 Token 和幂等空间。

开发地址会随账号/部署变化，请配置 Base URL，不在客户端硬编码账号域名。公网请求使用 HTTPS。此开发环境会真实写入 D1/R2；集成测试仅使用授权图片或合成图。

管理员应先为你创建用户并安全分发业务 Token。Token 格式为 `lm_` 加 64 个小写十六进制字符；默认有效期 90 天，管理员可指定其他期限。`Bearer` 大小写按上述写法，Token 前后不要多空格或换行。

**客户端不需要 Cloudflare OAuth/API Token、S3 密钥、D1 ID、桶名或 owner_id。** 不要使用旧共享 `UPLOAD_TOKEN`；当前服务不开放自助注册、登录或签发接口。管理员操作见 [README](README.md)；部署见 [部署 Skill](../skills/deploy_worker/SKILL.md)。

当前没有 CORS 支持或 OPTIONS 预检处理。不同源浏览器前端会受到跨域限制；先通过 CLI、原生客户端或受控同源后端集成，不把 Token 嵌入公开网页、源码或 URL。浏览器对接需要另行实现 CORS 和适合浏览器的凭据存储方案。

## 2. 上传字段

每个字段最多出现一次，未知字段会被拒绝；每次只上传一张图片。

| 字段 | 必填 | 类型与限制 |
| --- | --- | --- |
| `file` | 是 | 文件，multipart Content-Type 必须是 `image/jpeg`，能被服务端实际解码 |
| `client_photo_id` | 是 | UUID 字符串；同一次逻辑上传必须稳定，服务端转为小写 |
| `source` | 是 | `cli` / `apple_app` / `device`；仅描述来源，不是身份 |
| `captured_at` | 否 | RFC 3339 时间，必须有时区，例如 `2026-11-19T15:30:00+08:00` 或 `2026-11-19T07:30:00Z`；小数最多 3 位 |
| `captured_at_source` | 否 | `exif` / `apple_photos` / `device` / `manual`；必须与 captured_at 成对 |

限制：

- JPEG 非空且不超过 **2,097,152 字节（2 MiB）**。
- 每条边不超过 **2048 px**。
- 整个 multipart 请求不超过 **3,145,728 字节（3 MiB）**，包括字段和分隔符。服务端限制实际读取量，不只看 Content-Length。
- 空字符串不是省略字段；拍摄时间未知时同时省略两个字段，不用上传时间冒充拍摄时间。
- 不支持任意远程图片 URL、PNG/HEIC/WebP 或一张请求中多个 file 字段。
- 不要提交 `owner_id`、`user_id`、桶名、对象键或输出 photo_id。

### 客户端图片准备

处理上传副本而非原图：应用 EXIF 方向，转 sRGB、按比例缩小（建议长边 1600 px，不放大小图），压成 JPEG，移除 GPS/设备序列号等隐私元数据。目标可为 200–500 KB，但以硬上限为准。特别需要细节时可用 2048px，不过服务端纯 JS 解码受 Cloudflare CPU 预算影响。

服务端只验证，不自动旋转、转换格式、重编码或清除 EXIF。重传必须使用已保存的同一份 JPEG 字节，不能每次重新压缩。

## 3. 主流客户端示例

本节示例已提供可执行版本，见 [test/clients/README.md](test/clients/README.md)。真实文件为 `upload.sh`、`upload.c`、`upload.cpp`、`upload.mjs`、`upload.py`；C/C++ 使用该目录的 `CMakeLists.txt`。从 Worker 目录运行 `npm run test:clients` 可执行不连接远端的五语言回归测试。真实文件支持 `EXPECT_STATUS` 精确断言，具体参数以该目录 README 为准。 所有客户端均支持默认开发地址、自动 UUID、--help 和成功摘要；C/C++/curl 使用实际上传速率（含 multipart 开销），Python/JS 使用文件大小/总请求耗时，非纯网络速率。位置参数统一为 `[BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]`，其他细节以真实文件和客户端 README 为准。

### 3.1 JavaScript：Node.js 原生 fetch

使用支持原生 fetch/FormData 的 Node.js。把下列内容保存为 `upload.mjs`；Token 仅从受限文件读取，不写入脚本、不作为命令参数传入。**FormData 会自动生成 multipart boundary，不要手动设置 Content-Type。**

```javascript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://lookme-api-dev.sunnyhaoming.workers.dev';
const HELP = `用法：node upload.mjs [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]
      node upload.mjs --help
      或通过环境变量 TOKEN_FILE、IMAGE_FILE 运行

参数说明：
  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加
                  默认：${DEFAULT_BASE_URL}
  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文
  JPEG_FILE       已处理的 JPEG 文件路径（环境变量为 IMAGE_FILE）
  CLIENT_PHOTO_ID  可选，省略时调用 crypto.randomUUID()，等价生成 UUIDv4
                  请求前输出；重试必须显式复用，不能再次省略

图片格式与限制（服务端校验）：
  仅支持可解码 JPEG（image/jpeg），不支持 PNG/HEIC/WebP
  单张非空图片不超过 2 MiB（2,097,152 字节），宽高不超过 2048 px
  multipart 请求总量不超过 3 MiB（3,145,728 字节）
  预先处理方向、sRGB、压缩及 GPS；服务端不转换或清除 EXIF

环境变量：BASE_URL、TOKEN_FILE、IMAGE_FILE、CLIENT_PHOTO_ID、EXPECT_STATUS
位置参数模式忽略同名配置环境变量（EXPECT_STATUS 除外）。
EXPECT_STATUS 可选，默认接受 200 或 201。
成功后显示响应、路径/大小、耗时及速度；速度为文件大小/请求耗时，非纯网络速率。
--help 不读取凭据、不上传；实际调用会写入目标服务。`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  let base = process.env.BASE_URL ?? DEFAULT_BASE_URL;
  let tokenFile = process.env.TOKEN_FILE;
  let imageFile = process.env.IMAGE_FILE;
  let clientId = process.env.CLIENT_PHOTO_ID;
  if (args.length) {
    base = /^https?:\/\//.test(args[0]) ? args.shift() : DEFAULT_BASE_URL;
    if (args.length !== 2 && args.length !== 3) throw new Error(HELP);
    [tokenFile, imageFile, clientId] = args;
  }
  if (!tokenFile || !imageFile) throw new Error(HELP);
  const expectedText = process.env.EXPECT_STATUS;
  const expected = expectedText === undefined ? null : Number(expectedText);
  if (expected !== null && (!/^\d{3}$/.test(expectedText) || expected < 100 || expected > 599)) {
    throw new Error('EXPECT_STATUS 必须为 HTTP 状态码');
  }
  clientId ??= randomUUID();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new Error('CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字');
  }
  console.log(`CLIENT_PHOTO_ID=${clientId}`);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^lm_[0-9a-f]{64}$/.test(token)) throw new Error('Token 文件格式无效');
  const path = resolve(imageFile);
  const jpeg = await readFile(path);
  const form = new FormData();
  form.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'upload.jpg');
  form.set('client_photo_id', clientId);
  form.set('source', 'cli');
  const url = `${base.replace(/\/+$/, '')}/photos`;
  const start = performance.now();
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  const elapsed = (performance.now() - start) / 1000;
  let body;
  try { body = JSON.parse(raw); } catch { body = { error: 'non_json_response' }; }
  console.log(JSON.stringify({ status: response.status, body }));
  if ([200, 201].includes(response.status)) {
    console.log(`上传成功（${response.status === 200 ? '幂等重传' : '首次保存'}）`);
    console.log(`文件路径：${path}`);
    console.log(`文件大小：${jpeg.length} 字节（${(jpeg.length / 1024).toFixed(2)} KiB）`);
    console.log(`上传类型：image/jpeg\n请求地址：${url}`);
    console.log(`请求耗时：${elapsed.toFixed(3)} 秒（含连接、上传及服务端响应）`);
    console.log(`平均上传速度：${(elapsed > 0 ? jpeg.length / 1024 / elapsed : 0).toFixed(2)} KiB/s（文件大小/请求耗时，非纯网络速率）`);
  }
  if (!(expected === null ? [200, 201].includes(response.status) : response.status === expected)) process.exitCode = 1;
}

try { await main(); } catch (error) {
  console.error(`未取得有效确认：${error.message}\n重试时保持已输出的 UUID、JPEG 和元数据。`);
  process.exitCode = 1;
}
```

调用示例（只有文件路径进入环境变量，Token 明文不进入命令）：

```bash
# 仅首次逻辑上传生成；失败重试不重新执行 uuidgen。
export CLIENT_PHOTO_ID="$(uuidgen)"
BASE_URL='https://lookme-api-dev.sunnyhaoming.workers.dev' \
TOKEN_FILE='/受限目录/用户.token' \
IMAGE_FILE='./processed.jpg' \
node upload.mjs
```

客户端应将 CLIENT_PHOTO_ID 和已处理 JPEG/元数据持久化到自己的上传状态，而不是仅保存在临时 shell 变量中。Node 示例不自动重试，避免不受控循环；30 秒是客户端超时选择，不是服务端 SLA。

### 3.2 命令行：curl

真实脚本见 `test/clients/upload.sh`，需要 Bash、curl 7.55+、Python 3；自动 UUID 需 uuidgen。脚本通过受限临时文件传递 Authorization，不把 Token 明文放进进程参数。

```bash
bash test/clients/upload.sh --help
# 首次自动 UUID，使用默认开发服务（真实上传）：
bash test/clients/upload.sh '/受限目录/用户.token' './processed.jpg'
# 重试时显式复用首次输出的 UUID：
bash test/clients/upload.sh 'https://lookme-api-dev.sunnyhaoming.workers.dev' \
  '/受限目录/用户.token' './processed.jpg' "$CLIENT_PHOTO_ID"
```

也支持无位置参数的 BASE_URL/TOKEN_FILE/IMAGE_FILE/CLIENT_PHOTO_ID 环境变量模式。不要开启 set -x、curl verbose/trace；脚本只清理本地临时请求头，不清理 D1/R2。

### 3.3 C：libcurl

依赖 libcurl 开发头文件及库；Linux 通常安装对应发行版的 libcurl 开发包，macOS 可使用系统 libcurl。保存为 `upload.c`：

```c
#define _XOPEN_SOURCE 700
#include <curl/curl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <sys/stat.h>

static const char *DEFAULT_BASE_URL = "https://lookme-api-dev.sunnyhaoming.workers.dev";

static void print_help(FILE *out) {
    fprintf(out,
        "用法：upload_c [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]\n"
        "      upload_c --help\n\n"
        "参数说明：\n"
        "  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加\n"
        "                  默认：%s\n"
        "  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文\n"
        "  JPEG_FILE       已处理的 JPEG 文件路径\n"
        "  CLIENT_PHOTO_ID  可选，省略时调用 uuidgen，并在请求前输出\n"
        "                  重试必须显式复用该 UUID，不能再次省略\n\n"
        "图片格式与限制（服务端校验）：\n"
        "  仅支持可解码 JPEG（image/jpeg），不支持 PNG/HEIC/WebP\n"
        "  单张非空图片，大小不超过 2 MiB（2,097,152 字节）\n"
        "  宽、高均不超过 2048 px\n"
        "  multipart 请求总量不超过 3 MiB（3,145,728 字节）\n"
        "  预先处理方向、sRGB、压缩及 GPS；服务端不转换或清除 EXIF\n\n"
        "环境变量：EXPECT_STATUS 可选，默认接受 200 或 201\n"
        "成功后显示响应、文件路径/大小、耗时及平均上传速度（含 multipart 开销）。\n"
        "--help 不读取凭据、不上传；实际调用会写入目标服务。\n", DEFAULT_BASE_URL);
}

static int valid_uuid(const char *id) {
    size_t i;
    if (strlen(id) != 36) return 0;
    for (i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (id[i] != '-') return 0;
        } else if (!isxdigit((unsigned char)id[i])) return 0;
    }
    return 1;
}

static int generate_uuid(char *id, size_t capacity) {
    FILE *pipe;
    int read, status;
#ifdef _WIN32
    pipe = _popen("uuidgen", "r");
#else
    pipe = popen("uuidgen", "r");
#endif
    if (!pipe) return 0;
    read = fgets(id, (int)capacity, pipe) != NULL;
#ifdef _WIN32
    status = _pclose(pipe);
#else
    status = pclose(pipe);
#endif
    id[strcspn(id, "\r\n")] = '\0';
    return read && status == 0 && valid_uuid(id);
}

int main(int argc, char **argv) {
    char token[70] = {0}, auth[100], url[2048], generated[128] = {0};
    size_t base_length;
    FILE *file = NULL;
    CURL *curl = NULL;
    struct curl_slist *headers = NULL, *added = NULL;
    curl_mime *mime = NULL;
    curl_mimepart *part = NULL;
    CURLcode result;
    long status = 0, expected = 0;
    double elapsed = 0;
    curl_off_t speed = 0;
    int rc = 1, n, first, custom_base;
    char *end = NULL, *file_path = NULL;
    const char *base, *client_id, *expected_text = getenv("EXPECT_STATUS");
    struct stat info;
    if (argc == 2 && strcmp(argv[1], "--help") == 0) {
        print_help(stdout);
        return 0;
    }
    custom_base = argc > 1 && (strncmp(argv[1], "http://", 7) == 0 || strncmp(argv[1], "https://", 8) == 0);
    first = custom_base ? 2 : 1;
    if (argc - first != 2 && argc - first != 3) {
        print_help(stderr);
        return 1;
    }
    base = custom_base ? argv[1] : DEFAULT_BASE_URL;
    if (expected_text) {
        expected = strtol(expected_text, &end, 10);
        if (!*expected_text || *end || expected < 100 || expected > 599) {
            fprintf(stderr, "EXPECT_STATUS 必须为 HTTP 状态码\n");
            return 1;
        }
    }
    if (argc - first == 3) client_id = argv[first + 2];
    else {
        if (!generate_uuid(generated, sizeof generated)) {
            fprintf(stderr, "uuidgen 失败；请安装 uuidgen 或显式提供 UUID\n");
            return 1;
        }
        client_id = generated;
    }
    if (!valid_uuid(client_id)) {
        fprintf(stderr, "CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字\n");
        return 1;
    }
    printf("CLIENT_PHOTO_ID=%s\n", client_id);
    fflush(stdout);
    file = fopen(argv[first], "rb");
    if (!file || !fgets(token, sizeof token, file)) {
        if (file) fclose(file);
        fprintf(stderr, "无法读取 Token 文件\n");
        return 1;
    }
    fclose(file);
    token[strcspn(token, "\r\n")] = '\0';
    if (strlen(token) != 67 || strncmp(token, "lm_", 3) != 0 || strspn(token + 3, "0123456789abcdef") != 64) {
        fprintf(stderr, "Token 文件格式无效\n");
        return 1;
    }
#ifdef _WIN32
    file_path = _fullpath(NULL, argv[first + 1], 0);
#else
    file_path = realpath(argv[first + 1], NULL);
#endif
    if (!file_path || stat(file_path, &info) != 0) {
        free(file_path);
        fprintf(stderr, "无法读取图片路径或大小\n");
        return 1;
    }
    base_length = strlen(base);
    while (base_length && base[base_length - 1] == '/') --base_length;
    if (!base_length || base_length > sizeof url - 8) { free(file_path); return 1; }
    n = snprintf(url, sizeof url, "%.*s/photos", (int)base_length, base);
    if (n < 0 || (size_t)n >= sizeof url) { free(file_path); return 1; }
    snprintf(auth, sizeof auth, "Authorization: Bearer %s", token);
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) { free(file_path); return 1; }
    curl = curl_easy_init();
    if (!curl) goto cleanup;
    headers = curl_slist_append(NULL, auth);
    if (!headers) goto cleanup;
    added = curl_slist_append(headers, "Expect:");
    if (!added) goto cleanup;
    headers = added;
    mime = curl_mime_init(curl);
    if (!mime) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "file") != CURLE_OK ||
        curl_mime_filedata(part, file_path) != CURLE_OK ||
        curl_mime_type(part, "image/jpeg") != CURLE_OK) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "client_photo_id") != CURLE_OK ||
        curl_mime_data(part, client_id, CURL_ZERO_TERMINATED) != CURLE_OK) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "source") != CURLE_OK ||
        curl_mime_data(part, "cli", CURL_ZERO_TERMINATED) != CURLE_OK) goto cleanup;
    if (curl_easy_setopt(curl, CURLOPT_URL, url) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_MIMEPOST, mime) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L) != CURLE_OK) goto cleanup;
    result = curl_easy_perform(curl);
    if (result != CURLE_OK) {
        fprintf(stderr, "未确认成功：%s；重试时保持同 UUID 和字节\n", curl_easy_strerror(result));
        goto cleanup;
    }
    if (curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status) != CURLE_OK) goto cleanup;
    printf("\nHTTP %ld\n", status);
    if (status == 200 || status == 201) {
        if (curl_easy_getinfo(curl, CURLINFO_TOTAL_TIME, &elapsed) != CURLE_OK ||
            curl_easy_getinfo(curl, CURLINFO_SPEED_UPLOAD_T, &speed) != CURLE_OK) goto cleanup;
        printf("上传成功（%s）\n文件路径：%s\n文件大小：%lld 字节（%.2f KiB）\n"
               "上传类型：image/jpeg\n请求地址：%s\n"
               "请求耗时：%.3f 秒（含连接、上传及服务端响应）\n"
               "平均上传速度：%.2f KiB/s（libcurl 统计，含 multipart 开销）\n",
               status == 200 ? "幂等重传" : "首次保存", file_path, (long long)info.st_size,
               info.st_size / 1024.0, url, elapsed, speed / 1024.0);
    }
    rc = (expected ? status == expected : (status == 200 || status == 201)) ? 0 : 1;
cleanup:
    if (mime) curl_mime_free(mime);
    if (headers) curl_slist_free_all(headers);
    if (curl) curl_easy_cleanup(curl);
    curl_global_cleanup();
    free(file_path);
    return rc;
}
```

编译与调用（不把 Token 明文作为参数）：

```bash
cc -std=c11 -Wall -Wextra upload.c -o upload-c $(pkg-config --cflags --libs libcurl)
# 没有 pkg-config 时使用：cc -std=c11 upload.c -o upload-c -lcurl
./upload-c 'https://lookme-api-dev.sunnyhaoming.workers.dev' \
  '/受限目录/用户.token' './processed.jpg' "$CLIENT_PHOTO_ID"
```

libcurl 默认验证 TLS 证书，勿设置跳过证书校验。multipart、文件读取和 Content-Type 由 libcurl 负责，不需要手工拼接请求。退出码 0 表示已收到 200/201，其他状态不代表可直接换 UUID 重试。

### 3.4 C++17：libcurl + RAII

同样使用 libcurl，以下为独立 C++ 示例 `upload.cpp`，用 RAII 释放句柄。Token 文件路径和图片路径进入参数，Token 本身只在内存中。

```cpp
#include <curl/curl.h>
#include <fstream>
#include <cstdlib>
#include <cstdio>
#include <regex>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

constexpr const char *DEFAULT_BASE_URL = "https://lookme-api-dev.sunnyhaoming.workers.dev";

void checked(CURLcode code) {
    if (code != CURLE_OK) throw std::runtime_error(curl_easy_strerror(code));
}

std::string generate_uuid() {
#ifdef _WIN32
    FILE *pipe = _popen("uuidgen", "r");
#else
    FILE *pipe = popen("uuidgen", "r");
#endif
    if (!pipe) throw std::runtime_error("无法执行 uuidgen；请安装 uuidgen 或显式提供 UUID");
    char buffer[128] = {};
    const bool read = fgets(buffer, sizeof buffer, pipe) != nullptr;
#ifdef _WIN32
    const int status = _pclose(pipe);
#else
    const int status = pclose(pipe);
#endif
    if (!read || status != 0) throw std::runtime_error("uuidgen 失败；请安装 uuidgen 或显式提供 UUID");
    std::string id = buffer;
    id.erase(id.find_last_not_of("\r\n") + 1);
    return id;
}

void print_help(std::ostream &output) {
    output <<
        "用法：upload_cpp [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]\n"
        "      upload_cpp --help\n\n"
        "参数说明：\n"
        "  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加\n"
        "                  默认：" << DEFAULT_BASE_URL << "\n" <<
        "  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文\n"
        "  JPEG_FILE       已处理的 JPEG 文件路径\n"
        "  CLIENT_PHOTO_ID  可选，省略时调用 uuidgen 生成并在请求前输出\n"
        "                  重试必须显式复用该 UUID，不能再次省略\n\n"
        "图片格式与限制（服务端校验）：\n"
        "  仅支持能实际解码的 JPEG（image/jpeg），不支持 PNG/HEIC/WebP\n"
        "  每次上传一张非空图片，文件大小不超过 2 MiB（2,097,152 字节）\n"
        "  宽、高均不超过 2048 px\n"
        "  multipart 请求总量不超过 3 MiB（3,145,728 字节，含字段与分隔符）\n"
        "  上传前自行应用方向、转为 sRGB、缩小/压缩并移除 GPS 等隐私元数据\n"
        "  服务端不自动转换格式、旋转、压缩或清除 EXIF；重试复用同一 JPEG 字节\n\n"
        "环境变量：\n"
        "  EXPECT_STATUS   可选，精确断言 HTTP 状态码；默认接受 200 或 201\n\n"
        "成功后显示服务端响应、文件路径/大小、耗时及平均上传速度（含 multipart 开销）。\n"
        "说明：--help 不读取凭据、不上传图片；实际上传会写入目标服务。\n";
}

int main(int argc, char **argv) {
    if (argc == 2 && std::string(argv[1]) == "--help") {
        print_help(std::cout);
        return 0;
    }
    const std::string first_arg = argc > 1 ? argv[1] : "";
    const bool custom_base = first_arg.rfind("https://", 0) == 0 || first_arg.rfind("http://", 0) == 0;
    const int first = custom_base ? 2 : 1;
    if (argc - first != 2 && argc - first != 3) {
        print_help(std::cerr);
        return 1;
    }
    const char *base_url = custom_base ? argv[1] : DEFAULT_BASE_URL;
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
    int exit_code = 1;
    try {
        long expected = 0;
        if (const char *text = std::getenv("EXPECT_STATUS")) {
            char *end = nullptr;
            expected = std::strtol(text, &end, 10);
            if (!*text || *end || expected < 100 || expected > 599)
                throw std::runtime_error("EXPECT_STATUS 必须为 HTTP 状态码");
        }
        const std::string client_id = argc - first == 3 ? argv[first + 2] : generate_uuid();
        if (!std::regex_match(client_id, std::regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")))
            throw std::runtime_error("CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字");
        std::cout << "CLIENT_PHOTO_ID=" << client_id << "\n" << std::flush;
        std::ifstream file(argv[first]);
        std::string token;
        if (!std::getline(file, token)) throw std::runtime_error("无法读取 Token 文件");
        if (!token.empty() && token.back() == '\r') token.pop_back();
        if (token.size() != 67 || token.substr(0, 3) != "lm_" ||
            token.find_first_not_of("0123456789abcdef", 3) != std::string::npos)
            throw std::runtime_error("Token 文件格式无效");
        const auto file_path = std::filesystem::absolute(argv[first + 1]);
        const auto file_size = std::filesystem::file_size(file_path);
        std::string url = base_url;
        while (!url.empty() && url.back() == '/') url.pop_back();
        if (url.empty()) throw std::runtime_error("Base URL 不能为空");
        url += "/photos";
        using Curl = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
        using Mime = std::unique_ptr<curl_mime, decltype(&curl_mime_free)>;
        using Headers = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>;
        Curl curl(curl_easy_init(), curl_easy_cleanup);
        if (!curl) throw std::runtime_error("无法初始化 libcurl");
        std::string auth = "Authorization: Bearer " + token;
        Headers headers(curl_slist_append(nullptr, auth.c_str()), curl_slist_free_all);
        if (!headers) throw std::runtime_error("无法分配请求头");
        Mime mime(curl_mime_init(curl.get()), curl_mime_free);
        if (!mime) throw std::runtime_error("无法分配 multipart");
        auto part = curl_mime_addpart(mime.get());
        if (!part) throw std::runtime_error("无法分配文件字段");
        checked(curl_mime_name(part, "file"));
        checked(curl_mime_filedata(part, argv[first + 1]));
        checked(curl_mime_type(part, "image/jpeg"));
        auto add = [&](const char *name, const char *value) {
            auto field = curl_mime_addpart(mime.get());
            if (!field) throw std::runtime_error("无法分配字段");
            checked(curl_mime_name(field, name));
            checked(curl_mime_data(field, value, CURL_ZERO_TERMINATED));
        };
        add("client_photo_id", client_id.c_str());
        add("source", "cli");
        checked(curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str()));
        checked(curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers.get()));
        checked(curl_easy_setopt(curl.get(), CURLOPT_MIMEPOST, mime.get()));
        checked(curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 30L));
        checked(curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, 10L));
        checked(curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 0L));
        checked(curl_easy_perform(curl.get()));
        long status = 0;
        checked(curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status));
        std::cout << "\nHTTP " << status << '\n';
        if (status == 200 || status == 201) {
            double elapsed = 0;
            curl_off_t upload_speed = 0;
            checked(curl_easy_getinfo(curl.get(), CURLINFO_TOTAL_TIME, &elapsed));
            checked(curl_easy_getinfo(curl.get(), CURLINFO_SPEED_UPLOAD_T, &upload_speed));
            std::cout << "上传成功" << (status == 200 ? "（幂等重传）" : "（首次保存）") << '\n'
                      << "文件路径：" << file_path.string() << '\n'
                      << "文件大小：" << file_size << " 字节（" << std::fixed << std::setprecision(2)
                      << file_size / 1024.0 << " KiB）\n"
                      << "上传类型：image/jpeg\n"
                      << "请求地址：" << url << '\n'
                      << "请求耗时：" << std::setprecision(3) << elapsed << " 秒（含连接、上传及服务端响应）\n"
                      << "平均上传速度：" << std::setprecision(2) << upload_speed / 1024.0
                      << " KiB/s（libcurl 统计，含 multipart 开销）\n";
        }
        exit_code = (expected ? status == expected : (status == 200 || status == 201)) ? 0 : 1;
    } catch (const std::exception &error) {
        std::cerr << "未确认成功：" << error.what() << '\n';
    }
    curl_global_cleanup();
    return exit_code;
}
```

```bash
c++ -std=c++17 -Wall -Wextra upload.cpp -o upload-cpp $(pkg-config --cflags --libs libcurl)
./upload-cpp 'https://lookme-api-dev.sunnyhaoming.workers.dev' \
  '/受限目录/用户.token' './processed.jpg' "$CLIENT_PHOTO_ID"
```

不要启用自动跟随重定向、TLS 绕过或 libcurl verbose；不把凭据发送到非预期主机。libcurl 可发送到本地 HTTP 开发服务，公网目标必须由应用限制为可信 HTTPS 地址。

### 3.5 Python 3：标准库

无需第三方依赖。保存为 `upload.py`；支持与 C++ 相同的位置参数，也保留环境变量模式。省略 UUID 时用 uuid.uuid4()，失败重试必须复用已输出的 UUID。

```python
#!/usr/bin/env python3
"""标准库上传 smoke test；支持位置参数/环境变量，不需要 requests。"""
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

DEFAULT_BASE_URL = 'https://lookme-api-dev.sunnyhaoming.workers.dev'
HELP = f'''用法：python3 upload.py [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]
      python3 upload.py --help
      或通过环境变量 TOKEN_FILE、IMAGE_FILE 运行

参数说明：
  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加
                  默认：{DEFAULT_BASE_URL}
  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文
  JPEG_FILE       已处理的 JPEG 文件路径（环境变量为 IMAGE_FILE）
  CLIENT_PHOTO_ID  可选，省略时调用 uuid.uuid4()，等价生成 UUIDv4
                  请求前输出；重试必须显式复用，不能再次省略

图片格式与限制（服务端校验）：
  仅支持可解码 JPEG（image/jpeg），不支持 PNG/HEIC/WebP
  单张非空图片不超过 2 MiB（2,097,152 字节），宽高不超过 2048 px
  multipart 请求总量不超过 3 MiB（3,145,728 字节）
  预先处理方向、sRGB、压缩及 GPS；服务端不转换或清除 EXIF

环境变量：BASE_URL、TOKEN_FILE、IMAGE_FILE、CLIENT_PHOTO_ID、EXPECT_STATUS
位置参数模式忽略同名配置环境变量（EXPECT_STATUS 除外）。
EXPECT_STATUS 可选，默认接受 200 或 201。
成功后显示响应、路径/大小、耗时及速度；速度为文件大小/请求耗时，非纯网络速率。
--help 不读取凭据、不上传；实际调用会写入目标服务。'''


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    args = sys.argv[1:]
    if args == ['--help']:
        print(HELP)
        return 0
    base = os.environ.get('BASE_URL', DEFAULT_BASE_URL)
    token_file, image_file = os.environ.get('TOKEN_FILE'), os.environ.get('IMAGE_FILE')
    client_id = os.environ.get('CLIENT_PHOTO_ID')
    if args:
        base = args.pop(0) if re.match(r'^https?://', args[0]) else DEFAULT_BASE_URL
        if len(args) not in (2, 3):
            raise ValueError(HELP)
        token_file, image_file = args[:2]
        client_id = args[2] if len(args) == 3 else None
    if not token_file or not image_file:
        raise ValueError(HELP)
    expected_text = os.environ.get('EXPECT_STATUS')
    if expected_text is not None and (not re.fullmatch(r'\d{3}', expected_text) or not 100 <= int(expected_text) <= 599):
        raise ValueError('EXPECT_STATUS 必须为 HTTP 状态码')
    if client_id is None:
        client_id = str(uuid.uuid4())
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', client_id):
        raise ValueError('CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字')
    print(f'CLIENT_PHOTO_ID={client_id}', flush=True)
    token = Path(token_file).read_text().strip()
    if not re.fullmatch(r'lm_[0-9a-f]{64}', token):
        raise ValueError('Token 文件格式无效')
    path = Path(image_file).resolve()
    image = path.read_bytes()
    boundary = uuid.uuid4().hex  # 仅为分隔符，不替换幂等键。
    parts = []
    for name, value in [('client_photo_id', client_id), ('source', 'cli')]:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + image + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    url = base.rstrip('/') + '/photos'
    request = Request(url, data=b''.join(parts), headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
    })
    start = time.perf_counter()
    try:
        response = build_opener(NoRedirect).open(request, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        status, raw = response.code, response.read()
    elapsed = time.perf_counter() - start
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        body = {'error': 'non_json_response'}
    print(json.dumps({'status': status, 'body': body}, ensure_ascii=False))
    if status in (200, 201):
        print('上传成功（' + ('幂等重传' if status == 200 else '首次保存') + '）')
        print(f'文件路径：{path}\n文件大小：{len(image)} 字节（{len(image) / 1024:.2f} KiB）')
        print(f'上传类型：image/jpeg\n请求地址：{url}')
        print(f'请求耗时：{elapsed:.3f} 秒（含连接、上传及服务端响应）')
        speed = len(image) / 1024 / elapsed if elapsed > 0 else 0
        print(f'平均上传速度：{speed:.2f} KiB/s（文件大小/请求耗时，非纯网络速率）')
    return 0 if (status == int(expected_text) if expected_text else status in (200, 201)) else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, URLError) as error:
        print(f'未取得有效确认：{error}\n重试时保持已输出的 UUID、JPEG 和元数据。', file=sys.stderr)
        sys.exit(1)
```

```bash
BASE_URL='https://lookme-api-dev.sunnyhaoming.workers.dev' \
TOKEN_FILE='/受限目录/用户.token' IMAGE_FILE='./processed.jpg' \
python3 upload.py
```

Python urllib 的 timeout 限制阻塞 I/O 等待，不是整次请求的统一截止时间；网络错误按第 5 节处理，重试复用原 UUID/字节。TLS 默认验证，不使用未验证的 SSL context。

## 4. 成功响应与幂等

首次确认上传 `201 Created`；相同请求幂等重传 `200 OK`：

```json
{
  "photo_id": "804a551a-47fc-4e63-9b08-a72fc7b84b20",
  "uploaded_at": "2026-11-19T08:00:00.000Z",
  "captured_at": "2026-11-19T07:30:00.000Z"
}
```

这是响应结构示例，不是现有照片记录。没有拍摄时间则没有 captured_at。响应不包含 owner、文件内容、R2 键或公开图片 URL。保存服务端 photo_id，不要把它与客户端 client_photo_id 混淆。

### 两种 UUID 的区别

- `client_photo_id` 是调用方 SDK 在第一次逻辑上传时自动生成并持久化的**幂等键**，重试必须复用。业务使用者不需要手工编写 UUID；示例显式传入是为了演示如何保持重试状态。
- `photo_id` 是服务器保存照片时自动生成的**照片标识**，成功后客户端保存响应中的值，无需提前提供。

若服务器在每次请求到达时都新生成幂等键，客户端无法在响应丢失后复用它，重传可能重复建档。因此当前 `client_photo_id` 必填；SDK 应把生成/保存逻辑封装起来，而不是改成每次网络请求都生成新 UUID。

幂等范围是 `(认证用户, client_photo_id)`：

- 同用户、同 UUID、同 JPEG 字节及 source/拍摄时间元数据 → 返回同一 photo_id，重传不更新原 uploaded_at。
- 同用户、同 UUID，换字节、source 或关键拍摄元数据 → `409 photo_conflict`，不能自动覆盖。
- 拍摄时间按 UTC 毫秒比较；同一时刻用不同时区表达可等价，captured_at_source 仍须一致。
- 不同用户可使用同 UUID，各自产生不同 photo_id，不共享记录。
- 本地文件名不参与幂等匹配；不能依赖文件名决定照片身份或顺序。

服务端先写 R2 再写 D1。只有 `200` / `201` 才确认成功。请求超时、网络断开或 `503` 不证明未写入：R2 已保存而 D1 失败可能产生孤儿对象，并发请求也可能留下未引用对象。客户端不得自行清桶或删除照片。

## 5. 错误与重试策略

错误通常为 JSON：`{"error":"错误标识"}`。代理或平台错误不保证是该 JSON 结构；客户端应先检查 HTTP 状态及可解析的响应类型。

| 状态 | error 标识 | 客户端处理 |
| --- | --- | --- |
| `400` | `invalid_multipart`、`invalid_fields`、`invalid_captured_at`、`invalid_file`、`empty_file` | 修正字段/编码，不原样循环重试 |
| `401` | `unauthorized` | Token 缺失、格式错误、未知、过期、撤销或用户停用；联系管理员，不泄露 Token 调试 |
| `404` | `not_found` | 核对 Base URL 和 `/photos` 路径 |
| `405` | 无 JSON 正文；Allow: POST | 改用 POST；GET/OPTIONS 不用于上传探测 |
| `409` | `photo_conflict` | 查明是否复用了 UUID 或重新压缩；新照片需新的逻辑上传 UUID |
| `413` | `request_too_large`、`file_too_large`、`dimensions_too_large` | 在首次上传前缩小副本；若已发生不确定结果，别直接换字节复用原 UUID |
| `415` | `multipart_required`、`invalid_jpeg` | 使用 multipart 和有效 JPEG，核对 MIME，不能只改扩展名 |
| `503` | `storage_unavailable` | 有界指数退避，保持 UUID/字节/元数据一致；持续失败交给服务维护者 |

建议重试仅用于网络错误、超时及暂时 `503`，采用带抖动的有界退避，例如最多 3 次额外尝试，等待约 1/2/4 秒。收到 `200` 或 `201` 停止；其他明确的 4xx 不自动重试。当前 API 不返回 Retry-After，也没有上传查询接口，不能通过 GET /photos 判断先前是否成功。

凭据轮换仍属于同一用户时可保留原上传 UUID；切换到另一用户会形成新的幂等空间，不能当成同一次上传恢复。

## 6. 对接验收清单

使用授权的两名测试用户和少量合成图：

- 无 Token 与错误 Token 返回 `401`；不要把 `503` 当作鉴权拒绝成功。
- 首传 `201`，同请求重传 `200` 且 photo_id/时间不变。
- 同用户同 UUID 换字节返回 `409`。
- 用户 B 同 UUID 得到自己的不同 photo_id；不得提交 owner_id 绕过身份。
- 非法 JPEG `415`，2 MiB + 1 字节文件 `413`；不做压力测试。
- 拍摄时间输出为 UTC；未知时间不出现 captured_at。
- 明文 Token、请求头和照片内容不进入集成日志；记录响应状态、客户端 UUID 和 photo_id 即可。

D1/R2 直接检查仅由管理员执行，客户端不需要管理权限。当前没有公开图片下载、列表、删除或漫画任务 API，也没有自动 TTL 清理；保留策略及后续接口必须另行约定。

## 7. 多张照片加速上传（C++）

`upload_batch_cpp` 使用同一进程的 libcurl multi 连接池，**每次最多并发8张**。每张仍是独立 `POST /photos` 请求；不要在一个请求中重复提交多个 file 字段。当前只实现 C++ 批量客户端，其他语言仍为单张客户端。

### 构建与首次调用

从 `worker-cloudflare/`：

```bash
cmake -S test/clients -B test/clients/build
cmake --build test/clients/build --config Release --target upload_batch_cpp
test/clients/build/upload_batch_cpp --help

# 会真实上传到开发服务；仅使用已授权图片。
test/clients/build/upload_batch_cpp \
  'https://api.fudaixuexue.eu.cc' \
  '/受限目录/用户.token' \
  './photo-a.jpg' './photo-b.jpg' './photo-c.jpg'
```

默认地址就是上述自定义域，因此 BASE_URL 可以省略。首次无需创建状态目录或传入 STATE_FILE：客户端自动创建 `~/.lookme-upload-batches/batch-UUID.upload-state`，POSIX 新目录为0700、状态文件为0600；已有不安全目录会被拒绝，不擅自更改权限。Windows 使用 USERPROFILE 目录/ACL，尚未实机验证。

发送第一个请求前会输出：

```text
STATE_FILE=/用户主目录/.lookme-upload-batches/batch-UUID.upload-state
```

此路径是示意值，恢复必须复制真实输出。所有照片 UUID 已保存到该文件；文件还包含路径、大小、修改时间和服务响应，不含 Token 明文，不要公开或提交 Git。

### 中断、部分失败与恢复

```bash
test/clients/build/upload_batch_cpp \
  --state '/首次输出的完整路径/batch-UUID.upload-state' \
  'https://api.fudaixuexue.eu.cc' \
  '/受限目录/用户.token'
```

- 用同一状态文件恢复，跳过200/201的成功照片，失败/未确认照片复用原UUID。
- 每次运行每张只尝试一次，不自动无限重试。全部已成功时不发送请求。
- 不带 --state 再次上传相同图片会创建新的独立批次，不能用作原批次重试。
- 服务地址、Token文件规范路径、所有源JPEG及其大小/修改时间须与原批次一致；不能改成其他用户Token恢复。
- `--state` 也能指定新批次保存位置，但父目录需已存在且受限。旧式 `.upload-state` 位置参数保持兼容，其他自选文件名使用 --state。
- Ctrl+C/SIGTERM取消活跃请求并释放锁；SIGKILL/断电留下的 `.lock` / `.tmp` 需要先确认没有进程使用再处理。

### 摘要与验证

显示每张UUID、HTTP状态、响应（含photo_id）、文件大小、耗时及libcurl平均上传速度；另显示发送进度、成功数量和批次总耗时/有效速率。发送进度不表示已保存到R2/D1。

单张速度包含multipart开销；批次有效速率为本次成功文件大小÷批次耗时，包含服务端处理，不是纯网络带宽，也不计入已跳过的历史成功照片。退出0表示全部确认成功，退出1表示部分失败或未确认。

本地协议测试（不访问远端）：

```bash
npm run test:batch
```

覆盖8并发、持久连接复用、部分失败/中断恢复、自动状态创建与权限、UUID稳定、文件变化及锁保护。更多细节见 [BATCH.md](test/clients/BATCH.md)。这不改变单张2MiB、2048px及请求3MiB的限制，也不保证所有网络都有8倍吞吐率。
