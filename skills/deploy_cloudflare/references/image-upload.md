# LookMe 图片上传协议（Demo）

`POST /photos` 已在 `worker-cloudflare/` 实现并通过本地测试，尚未部署。下文建单、查询和下载仍是实现约定，尚未实现；不可将其示例视为可用接口。部署步骤见 [上传 Worker 部署 Skill](../../deploy_worker/SKILL.md)。Apple App、硬件和 R2 直传之后接入。

## 图片准备

- 先提取可信拍摄时间：格式 RFC 3339，须含时区。没有可信时间或时区时同时省略拍摄时间及来源；服务端另记录上传时间。
- 应用 EXIF 旋转与镜像，转 sRGB，保留比例不裁切、不放大小图；长边默认最多 1600 px，JPEG 质量约 0.8，目标 200–500 KB。特别需要人脸细节时允许 2048 px 档。
- 去掉 GPS、设备序列号等不必要元数据。上传副本，不改原图。每张图片保留同一个 `client_photo_id` 和同一份已处理 JPEG，直到收到服务器确认。

## 1. 上传一张图片

`POST /photos`，HTTPS，携带仅有业务权限的 Demo bearer。用 multipart 携带文件二进制，不能 Base64。表单字段：

| 字段 | 说明 |
| --- | --- |
| `file` | 单张 JPEG；文件非空且不超过 2 MiB，最长边 ≤ 2048 px；请求总量另限 3 MiB |
| `client_photo_id` | 客户端生成稳定 UUID；仅在重传同一照片请求时复用 |
| `source` | Demo 为 `cli`，不作为身份凭据 |
| `captured_at` / `captured_at_source` | 可选成对提交，例如 `2026-11-19T15:30:00+08:00` 和 `exif`；允许 `exif`、`apple_photos`、`device`、`manual` |

```bash
BASE_URL='https://YOUR-API-HOST'
# 注入 LOOKME_TOKEN，不把真实值写进文档/命令历史；关闭 shell tracing。
PHOTO_CLIENT_ID=$(uuidgen)
curl --silent --show-error --fail-with-body "$BASE_URL/photos" \
  -H "Authorization: Bearer $LOOKME_TOKEN" \
  -F 'file=@photo-a.jpg;type=image/jpeg' \
  -F "client_photo_id=$PHOTO_CLIENT_ID" \
  -F 'source=cli' \
  -F 'captured_at=2026-11-19T15:30:00+08:00' \
  -F 'captured_at_source=exif'
```

首传 `201`，幂等重传 `200`；响应含 `photo_id`、`uploaded_at` 和可选 UTC `captured_at`，不返回 R2 键。API 先限制读取量（不能只信 `Content-Length`），核验 JPEG 实际格式、尺寸、文件大小，再算摘要、写 R2 并确认 D1。上传超时用同样文件、字段与 ID 逐张重试，遵从服务端退避。同 ID 换字节或关键元数据返回 `409`，不要自动覆盖。缺失/无效认证 `401`，无法访问他人资源按 `404` 处理，格式不支持 `415`，超限 `413`，字段无效 `400`。

## 2. 建单、轮询、下载

再上传两张，分别记录服务端的 `photo_id`。数组顺序就是漫画参考顺序，不根据文件名或上传时间自动重排。

```bash
# 替换三项 photo_id；重试同一份请求需要保留 client_job_id。
JOB_CLIENT_ID=$(uuidgen)
curl --silent --show-error --fail-with-body "$BASE_URL/comic-jobs" \
  -H "Authorization: Bearer $LOOKME_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"client_job_id\":\"$JOB_CLIENT_ID\",\"photo_ids\":[\"PHOTO_1\",\"PHOTO_2\",\"PHOTO_3\"]}"
```

返回 `202` 和 `job_id`。相同请求重发返回同一任务；同一键用不同输入顺序返回 `409`。每隔数秒查询 `GET /comic-jobs/:id`，遵守 `Retry-After`（若有）；遇到 `failed` 或 `needs_review` 停止轮询，不擅自重建付费任务。

```bash
JOB_ID='使用返回的 job_id'
curl --silent --show-error --fail-with-body "$BASE_URL/comic-jobs/$JOB_ID" \
  -H "Authorization: Bearer $LOOKME_TOKEN"

# 状态 succeeded 后执行。
curl --silent --show-error --fail-with-body "$BASE_URL/comic-jobs/$JOB_ID/result" \
  -H "Authorization: Bearer $LOOKME_TOKEN" \
  -o comic.png
```

下载接口检查任务归属和已完成状态，从私有 R2 binding 流式返回 `image/png` 和 `Cache-Control: private, no-store`，不需要给 API Worker 增加 S3 签名凭据。测试时记录响应码与 job_id，不记录 token 或照片内容。
