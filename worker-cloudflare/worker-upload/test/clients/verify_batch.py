#!/usr/bin/env python3
"""C++ 批量上传本地协议测试：并发上限、复用连接、恢复及状态保护。"""
from collections import Counter
from email import policy
from email.parser import BytesParser
import hashlib
import argparse
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
WORKER = HERE.parents[1]
TOKEN = 'lm_' + 'a' * 64


def run(command, expected=0, **kwargs):
    result = subprocess.run(command, text=True, capture_output=True, timeout=90, **kwargs)
    if result.returncode != expected:
        raise RuntimeError(f'期望退出 {expected}，实际 {result.returncode}\n{result.stdout}\n{result.stderr}')
    assert TOKEN not in result.stdout + result.stderr
    return result


def entries(path):
    text = path.read_text()
    if text.startswith('{'):
        data = json.loads(text)
        assert data['format'] == 'LOOKME_NATIVE_BATCH_V1'
        return data['jobs']
    fields = shlex.split(text)
    assert fields[0] in ('LOOKME_BATCH_V1', 'LOOKME_C_BATCH_V1')
    count = int(fields[3])
    assert len(fields) == 4 + count * 6
    return [dict(path=fields[i], uuid=fields[i+1], size=int(fields[i+2]), modified=fields[i+3],
                 status=int(fields[i+4]), response=fields[i+5]) for i in range(4, len(fields), 6)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', choices=['cpp','c','js','python','curl'], default='cpp')
    parser.add_argument('--all', action='store_true')
    options = parser.parse_args()
    if options.all:
        for language in ['cpp','c','js','python','curl']:
            run([sys.executable, '-I', str(Path(__file__).resolve()), '--language', language])
            print(language+' 原生批量测试通过')
        return
    records, attempts = {}, Counter()
    active = peak = 0
    connections = set()
    guard = threading.Lock()
    fail_digest = None
    with tempfile.TemporaryDirectory(prefix='lookme-batch-tests-') as folder:
        root = Path(folder)
        build = root / 'build'
        suffix = '.exe' if os.name == 'nt' else ''
        if options.language in ('cpp', 'c'):
            target = 'upload_batch_cpp' if options.language == 'cpp' else 'upload_batch_c'
            run(['cmake', '-S', str(HERE), '-B', str(build)])
            run(['cmake', '--build', str(build), '--config', 'Release', '--target', target])
            binary = build/(target+suffix)
            if not binary.exists(): binary = build/'Release'/(target+suffix)
            executable = [str(binary)]
        elif options.language == 'js': executable = ['node', str(HERE/'upload_batch.mjs')]
        elif options.language == 'python': executable = [sys.executable, '-I', str(HERE/'upload_batch.py')]
        else: executable = ['bash', str(HERE/'upload_batch.sh')]
        (root/'token').write_text(TOKEN+'\n')
        fixture_script = "import{encode}from'jpeg-js';import{writeFileSync}from'node:fs';for(let i=0;i<12;i++)writeFileSync(process.argv[1]+'/'+i+'.jpg',encode({width:8,height:8,data:new Uint8Array(256).fill(i*10)},80).data);"
        run(['node', '--input-type=module', '-e', fixture_script, str(root)], cwd=WORKER)
        files = [root/f'{i}.jpg' for i in range(12)]
        fail_digest = hashlib.sha256(files[0].read_bytes()).hexdigest()
        states = root/'states'
        states.mkdir(mode=0o700)

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args): pass

            def handle(self):
                try: super().handle()
                except (ConnectionResetError, BrokenPipeError): pass

            def do_POST(self):
                nonlocal active, peak
                length = int(self.headers['Content-Length'])
                payload = self.rfile.read(length)
                with guard:
                    active += 1
                    peak = max(peak, active)
                    connections.add(self.client_address)
                try:
                    assert self.path == '/photos'
                    assert self.headers.get('Authorization') == 'Bearer '+TOKEN
                    header = ('Content-Type: '+self.headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()
                    message = BytesParser(policy=policy.default).parsebytes(header+payload)
                    fields = {p.get_param('name', header='Content-Disposition'): p for p in message.iter_parts()}
                    assert set(fields) == {'file', 'source', 'client_photo_id'}
                    assert fields['file'].get_content_type() == 'image/jpeg'
                    assert fields['source'].get_payload(decode=True) == b'cli'
                    key = fields['client_photo_id'].get_payload(decode=True).decode()
                    uuid.UUID(key)
                    digest = hashlib.sha256(fields['file'].get_payload(decode=True)).hexdigest()
                    # 等待模拟服务端处理，让测试能观察真实并发和连接池行为。
                    time.sleep(0.2)
                    with guard:
                        attempts[key] += 1
                        if digest == fail_digest and attempts[key] == 1:
                            status, body = 503, {'error': 'storage_unavailable'}
                        else:
                            status = 200 if key in records else 201
                            if key in records: assert records[key][0] == digest
                            records.setdefault(key, (digest, str(uuid.uuid4())))
                            body = {'photo_id': records[key][1], 'uploaded_at': '2026-11-19T08:00:00.000Z'}
                    data = json.dumps(body).encode()
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (AssertionError, ValueError, BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with guard: active -= 1

        class Server(ThreadingHTTPServer):
            request_queue_size = 128

        server = Server(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}'
        state = states/'batch.upload-state'
        command = executable+['--state', str(state), base, str(root/'token')]
        try:
            help_result = run(executable+['--help'])
            for text in ['最多并发 8 张', 'BASE_URL', 'TOKEN_FILE', '--state', 'JPEG_FILE', '0700', '0600', '恢复', '退出0' if options.language not in ('cpp',) else '退出 0', '2 MiB', '3 MiB']:
                assert text in help_result.stdout, text
            first = run(command+list(map(str, files)), expected=1)
            assert '已成功 11/12' in first.stdout
            rows = entries(state)
            assert len(rows) == 12 and len({r['uuid'] for r in rows}) == 12
            assert sum(r['status'] in (200, 201) for r in rows) == 11
            assert state.stat().st_mode & 0o777 == 0o600
            assert TOKEN not in state.read_text()
            assert peak == 8, f'观察到最大并发 {peak}，期望 8'
            assert len(connections) <= 8, f'首批使用连接数 {len(connections)}，未复用池'
            counts = attempts.copy()
            second = run(command)
            assert '已成功 12/12' in second.stdout
            recovered = entries(state)
            assert [r['uuid'] for r in recovered] == [r['uuid'] for r in rows]
            assert sum(attempts.values()) - sum(counts.values()) == 1
            third = run(command)
            assert '本次成功文件：0 字节' in third.stdout
            assert len(records) == 12 and len(attempts) == 12
            assert '批次耗时' in second.stdout and '有效平均速率' in second.stdout
            print('通过：8 并发上限、最多 8 个持久连接、11/12 部分成功、仅重试失败图、UUID 稳定、全部完成后零上传。')

            legacy = run(executable+[base, str(root/'token'), str(state)])
            assert '本次成功文件：0 字节' in legacy.stdout
            home = root/'home'
            home.mkdir(mode=0o700)
            env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home)}
            auto = run(executable+[base, str(root/'token'), str(files[1]), str(files[2])], env=env)
            state_line = next(line for line in auto.stdout.splitlines() if line.startswith('STATE_FILE='))
            auto_state = Path(state_line.split('=', 1)[1])
            assert auto_state.parent.resolve() == (home/'.lookme-upload-batches').resolve()
            assert auto_state.parent.stat().st_mode & 0o777 == 0o700
            assert auto_state.stat().st_mode & 0o777 == 0o600
            auto_rows = entries(auto_state)
            assert len(auto_rows) == 2 and TOKEN not in auto_state.read_text()
            assert auto.stdout.index('STATE_FILE=') < auto.stdout.index('开始：')
            resume_auto = run(executable+['--state', str(auto_state), base, str(root/'token')], env=env)
            assert '本次成功文件：0 字节' in resume_auto.stdout
            assert [r['uuid'] for r in entries(auto_state)] == [r['uuid'] for r in auto_rows]
            new = run(executable+[base, str(root/'token'), str(files[3])], env=env)
            new_state = next(line.split('=', 1)[1] for line in new.stdout.splitlines() if line.startswith('STATE_FILE='))
            assert new_state != str(auto_state) and entries(auto_state) == auto_rows
            if options.language == 'python':
                checkpoint = attempts.copy()
                run(['node', str(HERE/'upload_batch.mjs'), '--state', str(auto_state), base, str(root/'token')], env=env)
                run(['bash', str(HERE/'upload_batch.sh'), '--state', str(auto_state), base, str(root/'token')], env=env)
                assert attempts == checkpoint
                assert [r['uuid'] for r in entries(auto_state)] == [r['uuid'] for r in auto_rows]
                print('通过：Python状态可由JS/curl恢复，不重传、不更改UUID。')
            automatic_dir = home/'.lookme-upload-batches'
            automatic_dir.chmod(0o755)
            bad_auto = run(executable+[base, str(root/'token'), str(files[3])], expected=1, env=env)
            assert '0700' in bad_auto.stderr and automatic_dir.stat().st_mode & 0o777 == 0o755
            automatic_dir.chmod(0o700)
            print('通过：自动创建0700目录/0600唯一状态，发送前输出路径，--state恢复不重传，旧.upload-state参数兼容，不修改已有目录权限。')

            before = attempts.copy()
            files[-1].write_bytes(files[-1].read_bytes()+b'changed')
            changed = run(command, expected=1)
            assert '图片已改变' in changed.stderr and attempts == before
            files[-1].write_bytes(files[-1].read_bytes()[:-7])
            # 同样字节但修改时间已改变，不能继续用此批次；新的状态用于后续中断测试。
            other_token = root/'other-token'
            other_token.write_text(TOKEN+'\n')
            mismatch = run(executable+['--state', str(state), base, str(other_token)], expected=1)
            assert 'Token' in mismatch.stderr and '路径' in mismatch.stderr and attempts == before
            (states/'locked.upload-state.lock').mkdir()
            locked = run(executable+['--state', str(states/'locked.upload-state'), base, str(root/'token'), str(files[1])], expected=1)
            assert ('锁' in locked.stderr or 'EEXIST' in locked.stderr or 'File exists' in locked.stderr)
            insecure = root/'insecure'
            insecure.mkdir(mode=0o755)
            refused = run(executable+['--state', str(insecure/'state'), base, str(root/'token'), str(files[1])], expected=1)
            assert '0700' in refused.stderr
            print('通过：文件变化、用户凭据路径切换、批次锁和目录权限均在上传前拒绝。')

            interrupt_state = states/'interrupt.upload-state'
            interrupt_command = executable+['--state', str(interrupt_state), base, str(root/'token')]
            process = subprocess.Popen(interrupt_command+list(map(str, files[1:5])), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic()+5
            while not interrupt_state.exists() and time.monotonic() < deadline: time.sleep(0.01)
            time.sleep(0.05)
            process.terminate()
            stdout, stderr = process.communicate(timeout=10)
            assert process.returncode != 0 and interrupt_state.exists()
            assert not Path(str(interrupt_state)+'.lock').exists()
            interrupted_rows = entries(interrupt_state)
            run(interrupt_command)
            assert [r['uuid'] for r in entries(interrupt_state)] == [r['uuid'] for r in interrupted_rows]
            assert '批次未全部确认成功' in stderr or '批次已中断' in stderr
            print('通过：中断释放锁，原状态文件可恢复，UUID 不变；仅本地合成图。')
        finally:
            server.shutdown()
            server.server_close()
    print('批量客户端验收完成：未访问 Cloudflare，临时图像/凭据/状态/构建已清理。')


if __name__ == '__main__':
    main()
