#!/usr/bin/env python3
"""本地协议回归：构建 C/C++，验证五种客户端；不访问 Cloudflare。"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email import policy
from email.parser import BytesParser
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import uuid

HERE = Path(__file__).resolve().parent
WORKER = HERE.parents[1]
TOKEN = 'lm_' + 'a' * 64  # 仅 mock 夹具，不是实际部署凭据。


def run(command, **kwargs):
    result = subprocess.run(command, capture_output=True, text=True, timeout=90, **kwargs)
    if result.returncode:
        raise RuntimeError(f'客户端/构建失败：{command[0]}\n{result.stdout}\n{result.stderr}')
    return result


def main():
    records = {}
    with tempfile.TemporaryDirectory(prefix='lookme-client-tests-') as folder:
        root = Path(folder)
        build = root / 'build'
        run(['cmake', '-S', str(HERE), '-B', str(build)])
        run(['cmake', '--build', str(build), '--config', 'Release'])
        fixture_script = "import {encode} from 'jpeg-js';import{writeFileSync}from'node:fs';for(const [file,value]of[[process.argv[1],120],[process.argv[2],20]])writeFileSync(file,encode({width:8,height:8,data:new Uint8Array(256).fill(value)},80).data);"
        run(['node', '--input-type=module', '-e', fixture_script, str(root/'image.jpg'), str(root/'different.jpg')], cwd=WORKER)
        (root/'invalid.jpg').write_bytes(b'not a jpeg')
        (root/'oversize.jpg').write_bytes(b'x' * (2 * 1024 * 1024 + 1))
        for filename, token in [('test.token', TOKEN), ('unknown.token', 'lm_'+'f'*64)]:
            (root/filename).write_text(token+'\n')
            (root/filename).chmod(0o600)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                status, body = 400, {'error': 'invalid_fields'}
                try:
                    # 完整读取请求，避免负向鉴权测试中客户端仍发送正文时连接被提前关闭。
                    data = self.rfile.read(int(self.headers['Content-Length']))
                    if self.path != '/photos':
                        status, body = 404, {'error': 'not_found'}
                    elif self.headers.get('Authorization') != 'Bearer '+TOKEN:
                        status, body = 401, {'error': 'unauthorized'}
                    else:
                        header = ('Content-Type: '+self.headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()
                        message = BytesParser(policy=policy.default).parsebytes(header+data)
                        parts = list(message.iter_parts())
                        fields = {p.get_param('name', header='Content-Disposition'): p for p in parts}
                        assert len(parts) == 3 and set(fields) == {'file', 'client_photo_id', 'source'}
                        assert fields['file'].get_content_type() == 'image/jpeg'
                        assert fields['source'].get_payload(decode=True) == b'cli'
                        key = fields['client_photo_id'].get_payload(decode=True).decode()
                        uuid.UUID(key)
                        image = fields['file'].get_payload(decode=True)
                        if len(image) > 2 * 1024 * 1024:
                            status, body = 413, {'error': 'file_too_large'}
                        elif not image.startswith(b'\xff\xd8'):
                            status, body = 415, {'error': 'invalid_jpeg'}
                        else:
                            digest = hashlib.sha256(image).hexdigest()
                            if key in records and records[key][0] != digest:
                                status, body = 409, {'error': 'photo_conflict'}
                            else:
                                status = 200 if key in records else 201
                                records.setdefault(key, (digest, str(uuid.uuid4())))
                                body = {'photo_id': records[key][1], 'uploaded_at': '2026-11-19T08:00:00.000Z'}
                except (AssertionError, KeyError, ValueError):
                    pass
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        suffix = '.exe' if os.name == 'nt' else ''
        binary_dir = build/'Release' if (build/'Release'/('upload_c'+suffix)).exists() else build
        programs = [
            ('curl', ['bash', str(HERE/'upload.sh')], False),
            ('C', [str(binary_dir/('upload_c'+suffix))], True),
            ('C++', [str(binary_dir/('upload_cpp'+suffix))], True),
            ('JavaScript', ['node', str(HERE/'upload.mjs')], False),
            ('Python', ['python3', '-I', str(HERE/'upload.py')], False),
        ]
        try:
            for name, command, positional in programs:
                client_id = str(uuid.uuid4())
                for status, image, credential in [
                    (201, 'image.jpg', 'test.token'), (200, 'image.jpg', 'test.token'),
                    (409, 'different.jpg', 'test.token'), (401, 'image.jpg', 'unknown.token'),
                    (415, 'invalid.jpg', 'test.token'), (413, 'oversize.jpg', 'test.token'),
                ]:
                    env = {**os.environ, 'BASE_URL': base, 'TOKEN_FILE': str(root/credential),
                           'IMAGE_FILE': str(root/image), 'CLIENT_PHOTO_ID': client_id, 'EXPECT_STATUS': str(status)}
                    args = [base, str(root/credential), str(root/image), client_id] if positional else []
                    try:
                        result = run(command+args, env=env)
                        if name == 'C++' and status in (200, 201):
                            for text in ['上传成功', '文件路径：', '文件大小：', '请求耗时：', '平均上传速度：', 'KiB/s']:
                                assert text in result.stdout, text
                            assert str(root/image) in result.stdout
                            assert f"{(root/image).stat().st_size} 字节" in result.stdout
                            assert TOKEN not in result.stdout
                    except RuntimeError as error:
                        raise RuntimeError(f"{name} 期望 {status}：{error}") from error
                print(f'{name}：201/200/409/401/415/413 本地协议测试通过')
            cpp = [str(binary_dir/('upload_cpp'+suffix))]
            env = {**os.environ, 'EXPECT_STATUS': '201'}
            generated = run(cpp+[base, str(root/'test.token'), str(root/'image.jpg')], env=env)
            match = re.search(r'CLIENT_PHOTO_ID=([0-9a-fA-F-]{36})', generated.stdout)
            assert match, '自动生成的 UUID 未输出'
            generated_id = match.group(1)
            uuid.UUID(generated_id)
            assert generated_id in records
            retry = run(cpp+[base, str(root/'test.token'), str(root/'image.jpg'), generated_id], env={**env, 'EXPECT_STATUS': '200'})
            assert '幂等重传' in retry.stdout
            print('C++：uuidgen 自动生成、显式重传及耗时/大小/路径/速度摘要通过')
        finally:
            server.shutdown()
            server.server_close()
    print('全部 32 项客户端测试通过；构建、合成图与夹具凭据仅存于已清理的临时目录。')


if __name__ == '__main__':
    main()
