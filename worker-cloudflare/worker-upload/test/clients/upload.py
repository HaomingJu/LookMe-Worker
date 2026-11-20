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
