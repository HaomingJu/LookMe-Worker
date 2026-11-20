#!/usr/bin/env bash
# Token 通过受限临时请求头文件传给 curl，不进入进程参数。
set -eu
DEFAULT_BASE_URL='https://lookme-api-dev.sunnyhaoming.workers.dev'
if [ "$#" -eq 1 ] && [ "$1" = '--help' ]; then
  cat <<HELP
用法：bash upload.sh [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]
      bash upload.sh --help
      或通过环境变量 TOKEN_FILE、IMAGE_FILE 运行

参数说明：
  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加
                  默认：$DEFAULT_BASE_URL
  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文
  JPEG_FILE       已处理的 JPEG 文件路径（环境变量为 IMAGE_FILE）
  CLIENT_PHOTO_ID  可选，省略时调用 uuidgen 并在请求前输出
                  重试必须显式复用，不能再次省略

图片格式与限制（服务端校验）：
  仅支持可解码 JPEG（image/jpeg），不支持 PNG/HEIC/WebP
  单张非空图片不超过 2 MiB（2,097,152 字节），宽高不超过 2048 px
  multipart 请求总量不超过 3 MiB（3,145,728 字节）
  预先处理方向、sRGB、压缩及 GPS；服务端不转换或清除 EXIF

环境变量：BASE_URL、TOKEN_FILE、IMAGE_FILE、CLIENT_PHOTO_ID、EXPECT_STATUS
位置参数模式忽略同名配置环境变量（EXPECT_STATUS 除外）。
EXPECT_STATUS 可选，默认接受 200 或 201。
成功后显示响应、路径/大小、耗时及速度（curl 统计，含 multipart 开销）。
--help 不读取凭据、不上传；实际调用会写入目标服务。
HELP
  exit 0
fi
if [ "$#" -gt 0 ]; then
  BASE_URL="$DEFAULT_BASE_URL"
  case "$1" in http://*|https://*) BASE_URL="$1"; shift ;; esac
  if [ "$#" -ne 2 ] && [ "$#" -ne 3 ]; then
    printf '用法：bash upload.sh [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]\n' >&2
    exit 1
  fi
  TOKEN_FILE="$1"
  IMAGE_FILE="$2"
  CLIENT_PHOTO_ID="${3-}"
else
  BASE_URL="${BASE_URL-$DEFAULT_BASE_URL}"
  : "${TOKEN_FILE:?需要 TOKEN_FILE}"
  : "${IMAGE_FILE:?需要 IMAGE_FILE}"
  CLIENT_PHOTO_ID="${CLIENT_PHOTO_ID-}"
fi
if [ -z "$CLIENT_PHOTO_ID" ]; then CLIENT_PHOTO_ID="$(uuidgen)"; fi
# 校验在读凭据、创建请求之前执行。
python3 -I - "$CLIENT_PHOTO_ID" <<'PY'
import re, sys
if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', sys.argv[1]):
    raise SystemExit('CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字')
PY
printf 'CLIENT_PHOTO_ID=%s\n' "$CLIENT_PHOTO_ID"
umask 077
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
python3 -I - "$TOKEN_FILE" "$TEMP_DIR" "$IMAGE_FILE" "${EXPECT_STATUS:-}" <<'PY'
from pathlib import Path
import json, re, sys
value = Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'lm_[0-9a-f]{64}', value):
    raise SystemExit('Token 文件格式无效')
if sys.argv[4] and (not re.fullmatch(r'\d{3}', sys.argv[4]) or not 100 <= int(sys.argv[4]) <= 599):
    raise SystemExit('EXPECT_STATUS 必须为 HTTP 状态码')
folder = Path(sys.argv[2])
path = Path(sys.argv[3]).resolve()
(folder / 'header').write_text(f'Authorization: Bearer {value}\n')
(folder / 'metadata').write_text(json.dumps({'path': str(path), 'size': path.stat().st_size}))
PY
# 不用 --fail：期望 4xx 时交由状态断言决定退出码，不跟随重定向。
METRICS="$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
  --header "@$TEMP_DIR/header" \
  --form "file=@$IMAGE_FILE;type=image/jpeg" \
  --form-string "client_photo_id=$CLIENT_PHOTO_ID" \
  --form-string 'source=cli' \
  --output "$TEMP_DIR/response" \
  --write-out '%{http_code}\n%{time_total}\n%{speed_upload}' \
  "${BASE_URL%/}/photos")"
cat "$TEMP_DIR/response"
python3 -I - "$METRICS" "$TEMP_DIR/metadata" "${BASE_URL%/}/photos" "${EXPECT_STATUS:-}" <<'PY'
import json, sys
status, elapsed, speed = sys.argv[1].splitlines()
status = int(status)
info = json.load(open(sys.argv[2]))
print(f'\nHTTP {status}')
if status in (200, 201):
    print('上传成功（' + ('幂等重传' if status == 200 else '首次保存') + '）')
    print(f"文件路径：{info['path']}\n文件大小：{info['size']} 字节（{info['size'] / 1024:.2f} KiB）")
    print(f'上传类型：image/jpeg\n请求地址：{sys.argv[3]}')
    print(f'请求耗时：{float(elapsed):.3f} 秒（含连接、上传及服务端响应）')
    print(f'平均上传速度：{float(speed) / 1024:.2f} KiB/s（curl 统计，含 multipart 开销）')
expected = sys.argv[4]
raise SystemExit(0 if (status == int(expected) if expected else status in (200, 201)) else 1)
PY
