# 图像上传 API 对接

本文供客户端开发者及其他 AI 对接已实现的 `POST /photos`。仅描述当前代码，不把规划中的建单、查询、漫画生成和下载接口视为可用功能。

## 1. 接入前提

| 项目 | 内容 |
| --- | --- |
| 开发环境 Base URL | `https://lookme-api-dev.sunnyhaoming.workers.dev` |
| 本地 Base URL | `http://localhost:8787`（以 Wrangler 输出为准） |
| 上传路径 | `/photos` |
| 方法 | `POST` |
| 编码 | `multipart/form-data`，文件二进制，不用 JSON/Base64 |
| 认证 | `Authorization: Bearer <独立用户Token>` |

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

本节示例已提供可执行版本，见 [test/clients/README.md](test/clients/README.md)。真实文件为 `upload.sh`、`upload.c`、`upload.cpp`、`upload.mjs`、`upload.py`；C/C++ 使用该目录的 `CMakeLists.txt`。从 Worker 目录运行 `npm run test:clients` 可执行不连接远端的五语言回归测试。真实文件支持 `EXPECT_STATUS` 精确断言，具体参数以该目录 README 为准。

### 3.1 JavaScript：Node.js 原生 fetch

使用支持原生 fetch/FormData 的 Node.js。把下列内容保存为 `upload.mjs`；Token 仅从受限文件读取，不写入脚本、不作为命令参数传入。**FormData 会自动生成 multipart boundary，不要手动设置 Content-Type。**

```javascript
import { readFile } from 'node:fs/promises';

async function uploadPhoto({ baseUrl, tokenFile, imageFile, clientPhotoId }) {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const jpeg = await readFile(imageFile);
  const form = new FormData();
  form.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'upload.jpg');
  form.set('client_photo_id', clientPhotoId);
  form.set('source', 'cli');
  // 有可信拍摄时间时同时设置两个字段；否则不要设置。
  // form.set('captured_at', '2026-11-19T15:30:00+08:00');
  // form.set('captured_at_source', 'manual');

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    redirect: 'error', // 不将凭据带到重定向目标。
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

const { BASE_URL, TOKEN_FILE, IMAGE_FILE, CLIENT_PHOTO_ID } = process.env;
if (![BASE_URL, TOKEN_FILE, IMAGE_FILE, CLIENT_PHOTO_ID].every(Boolean)) {
  throw new Error('需要 BASE_URL、TOKEN_FILE、IMAGE_FILE、CLIENT_PHOTO_ID');
}
try {
  const result = await uploadPhoto({
    baseUrl: BASE_URL, tokenFile: TOKEN_FILE,
    imageFile: IMAGE_FILE, clientPhotoId: CLIENT_PHOTO_ID,
  });
  console.log(JSON.stringify(result)); // 只输出状态和业务响应，不输出凭据。
  if (![200, 201].includes(result.status)) process.exitCode = 1;
} catch {
  console.error('未取得上传确认；保留同一 UUID、JPEG 和元数据后再按退避策略重试。');
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

需要支持 `--header @文件` 和 `--fail-with-body` 的 curl（建议 7.76+），及 Python 3。用受限临时文件传递 Authorization，避免 `curl -H "Bearer ..."` 将 Token 放进进程参数。以下示例使用已有环境变量 CLIENT_PHOTO_ID；只在首次上传时生成一次 UUID。

```bash
export CLIENT_PHOTO_ID="$(uuidgen)"  # 重试时保留这个值。
BASE_URL='https://lookme-api-dev.sunnyhaoming.workers.dev'
TOKEN_FILE='/受限目录/用户.token'
IMAGE_FILE='./processed.jpg'

(
  umask 077
  HEADER_FILE="$(mktemp)" || exit 1
  trap 'rm -f "$HEADER_FILE"' EXIT
  python3 -I - "$TOKEN_FILE" "$HEADER_FILE" <<'PYHEADER'
from pathlib import Path
import re, sys
value = Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'lm_[0-9a-f]{64}', value):
    raise SystemExit('Token 文件格式无效')
Path(sys.argv[2]).write_text(f'Authorization: Bearer {value}\n')
PYHEADER
  if [ "$?" -ne 0 ]; then exit 1; fi
  curl --silent --show-error --fail-with-body --max-time 30 \
    --header "@$HEADER_FILE" \
    --form "file=@$IMAGE_FILE;type=image/jpeg" \
    --form-string "client_photo_id=$CLIENT_PHOTO_ID" \
    --form-string 'source=cli' \
    --write-out '\nHTTP %{http_code}\n' \
    "${BASE_URL%/}/photos"
)
```

不要使用 `set -x`、curl `--verbose` / `--trace`。脚本只清理本地临时请求头文件，不清理 D1/R2。需要拍摄时间时增加两个 `--form-string` 字段。不要手工设置 multipart Content-Type。

### 3.3 C：libcurl

依赖 libcurl 开发头文件及库；Linux 通常安装对应发行版的 libcurl 开发包，macOS 可使用系统 libcurl。保存为 `upload.c`：

```c
#include <curl/curl.h>
#include <stdio.h>
#include <string.h>

/* argv：Base URL、Token 文件路径、JPEG 路径、稳定客户端 UUID。 */
int main(int argc, char **argv) {
    char token[70] = {0}, auth[100], url[2048];
    size_t base_length;
    FILE *file = NULL;
    CURL *curl = NULL;
    struct curl_slist *headers = NULL;
    struct curl_slist *added = NULL;
    curl_mime *mime = NULL;
    curl_mimepart *part = NULL;
    CURLcode result = CURLE_OK;
    long status = 0;
    int rc = 1, n = 0;
    if (argc != 5) {
        fprintf(stderr, "用法：upload BASE_URL TOKEN_FILE JPEG_FILE CLIENT_PHOTO_ID\n");
        return 1;
    }
    file = fopen(argv[2], "rb");
    if (!file || !fgets(token, sizeof token, file)) {
        if (file) fclose(file);
        fprintf(stderr, "无法读取 Token 文件\n");
        return 1;
    }
    fclose(file);
    token[strcspn(token, "\r\n")] = '\0';
    if (strlen(token) != 67 || strncmp(token, "lm_", 3) != 0 ||
        strspn(token + 3, "0123456789abcdef") != 64) {
        fprintf(stderr, "Token 文件格式无效\n");
        return 1;
    }
    base_length = strlen(argv[1]);
    while (base_length && argv[1][base_length - 1] == '/') --base_length;
    if (!base_length || base_length > sizeof url - 8) return 1;
    n = snprintf(url, sizeof url, "%.*s/photos", (int)base_length, argv[1]);
    if (n < 0 || (size_t)n >= sizeof url) return 1;
    snprintf(auth, sizeof auth, "Authorization: Bearer %s", token);
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
    curl = curl_easy_init();
    if (!curl) goto cleanup;
    headers = curl_slist_append(NULL, auth);
    if (!headers) goto cleanup;
    /* 禁止较大文件自动触发 Expect: 100-continue，简化跨代理测试。 */
    added = curl_slist_append(headers, "Expect:");
    if (!added) goto cleanup;
    headers = added;
    mime = curl_mime_init(curl);
    if (!mime) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "file") != CURLE_OK ||
        curl_mime_filedata(part, argv[3]) != CURLE_OK ||
        curl_mime_type(part, "image/jpeg") != CURLE_OK) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "client_photo_id") != CURLE_OK ||
        curl_mime_data(part, argv[4], CURL_ZERO_TERMINATED) != CURLE_OK) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "source") != CURLE_OK ||
        curl_mime_data(part, "cli", CURL_ZERO_TERMINATED) != CURLE_OK) goto cleanup;
    if (curl_easy_setopt(curl, CURLOPT_URL, url) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_MIMEPOST, mime) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L) != CURLE_OK) goto cleanup;
    /* 默认仅把响应正文写到 stdout，不启用包含请求头的调试输出。 */
    result = curl_easy_perform(curl);
    if (result != CURLE_OK) {
        fprintf(stderr, "未确认成功：%s；重试时保持同 UUID 和字节\n", curl_easy_strerror(result));
        goto cleanup;
    }
    if (curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status) != CURLE_OK) goto cleanup;
    printf("\nHTTP %ld\n", status);
    rc = (status == 200 || status == 201) ? 0 : 1;
cleanup:
    if (mime) curl_mime_free(mime);
    if (headers) curl_slist_free_all(headers);
    if (curl) curl_easy_cleanup(curl);
    curl_global_cleanup();
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
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

void checked(CURLcode code) {
    if (code != CURLE_OK) throw std::runtime_error(curl_easy_strerror(code));
}

int main(int argc, char **argv) {
    if (argc != 5) {
        std::cerr << "用法：upload BASE_URL TOKEN_FILE JPEG_FILE CLIENT_PHOTO_ID\n";
        return 1;
    }
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
    int exit_code = 1;
    try {
        std::ifstream file(argv[2]);
        std::string token;
        if (!std::getline(file, token)) throw std::runtime_error("无法读取 Token 文件");
        if (!token.empty() && token.back() == '\r') token.pop_back();
        if (token.size() != 67 || token.substr(0, 3) != "lm_" ||
            token.find_first_not_of("0123456789abcdef", 3) != std::string::npos)
            throw std::runtime_error("Token 文件格式无效");
        std::string url = argv[1];
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
        checked(curl_mime_filedata(part, argv[3]));
        checked(curl_mime_type(part, "image/jpeg"));
        auto add = [&](const char *name, const char *value) {
            auto field = curl_mime_addpart(mime.get());
            if (!field) throw std::runtime_error("无法分配字段");
            checked(curl_mime_name(field, name));
            checked(curl_mime_data(field, value, CURL_ZERO_TERMINATED));
        };
        add("client_photo_id", argv[4]);
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
        exit_code = (status == 200 || status == 201) ? 0 : 1;
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

### 3.5 Python 3：requests

需要 `requests`（在自己的客户端项目/虚拟环境安装，不为此改变 Worker 依赖）。保存为 `upload.py`；Token 从 TOKEN_FILE 路径读取，CLIENT_PHOTO_ID 来自已持久化的上传状态。

```python
import json
import os
from pathlib import Path
import requests

base = os.environ['BASE_URL'].rstrip('/')
token = Path(os.environ['TOKEN_FILE']).read_text().strip()
with open(os.environ['IMAGE_FILE'], 'rb') as image:
    response = requests.post(
        base + '/photos',
        headers={'Authorization': 'Bearer ' + token},
        files={'file': ('upload.jpg', image, 'image/jpeg')},
        data={'client_photo_id': os.environ['CLIENT_PHOTO_ID'], 'source': 'cli'},
        timeout=(10, 30),
        allow_redirects=False,
    )
try:
    body = response.json()
except ValueError:
    body = {'error': 'non_json_response'}
print(json.dumps({'status': response.status_code, 'body': body}, ensure_ascii=False))
raise SystemExit(0 if response.status_code in (200, 201) else 1)
```

```bash
BASE_URL='https://lookme-api-dev.sunnyhaoming.workers.dev' \
TOKEN_FILE='/受限目录/用户.token' IMAGE_FILE='./processed.jpg' \
python3 upload.py
```

requests 的超时分别限制连接与读取等待，并非整次上传的统一截止时间；网络异常由调用方按第 5 节处理，重试时重新打开同一 JPEG。TLS 默认验证，不设置 `verify=False`。也可参考 README 中无需第三方库的 Python urllib 例子。

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
