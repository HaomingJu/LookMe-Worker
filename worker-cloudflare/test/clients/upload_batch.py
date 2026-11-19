#!/usr/bin/env python3
"""Python 持久连接线程池；curl 模式使用独立 curl parallel 传输。"""
from concurrent.futures import ThreadPoolExecutor
import base64
import http.client
import json
import os
from pathlib import Path
import queue
import re
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit, unquote
from urllib.request import proxy_bypass_environment
import uuid

BASE = 'https://api.fudaixuexue.eu.cc'
SUCCESS = (200, 201)


def help_text(curl=False):
    program = 'bash upload_batch.sh' if curl else 'python3 upload_batch.py'
    return f'''首次：{program} [BASE_URL] TOKEN_FILE JPEG_FILE...
恢复：{program} --state STATE_FILE [BASE_URL] TOKEN_FILE
自选：{program} --state STATE_FILE [BASE_URL] TOKEN_FILE JPEG_FILE...
帮助：{program} --help
BASE_URL 可选，默认 {BASE}；TOKEN_FILE 必填，是文件路径，不是Token明文。
JPEG_FILE 首次至少一张；恢复可省略，不接受目录/重复路径。
--state 可选，默认在主目录 .lookme-upload-batches 创建唯一状态文件。
POSIX 新目录0700、文件0600；已有目录不自动改权限，请求前输出STATE_FILE。
最多并发 8 张，{'单个curl parallel进程复用连接，需curl 7.75+' if curl else '8个线程独立持久HTTP连接，Python标准库，不依赖C++'}。
每次每张尝试一次；恢复跳过200/201，UUID不变；切勿创建新状态重试旧批次。
JPEG非空且≤2 MiB，每边2048px、请求3 MiB，实际格式由服务端校验。
保持原图片大小/修改时间、服务地址、Token路径；凭据必须属于同一用户。
显示HTTP状态/响应/大小/耗时/速度和批次进度；发送不等于保存成功。
速度{'由curl统计（含multipart）' if curl else '为文件大小/请求耗时（含服务端处理），非纯网络带宽'}。
退出0全部成功，退出1部分失败；支持HTTP(S)目标和HTTP代理环境变量。
--help不读取凭据、不创建状态、不上传；状态包含本地路径/响应，勿公开。
Python/JS/curl共用JSON状态格式，C/C++状态格式不同。'''


def save_state(path, data):
    temp = Path(str(path)+'.tmp')
    created = False
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if created and temp.exists(): temp.unlink()


def verify(job):
    stat = Path(job['path']).stat()
    if not Path(job['path']).is_file() or stat.st_size != job['size'] or str(stat.st_mtime_ns) != job['modified']:
        raise ValueError('图片已改变或不存在：'+job['path'])


def prepare(args, curl):
    if args == ['--help']:
        print(help_text(curl)); return None
    chosen, positional = None, []
    index = 0
    while index < len(args):
        if args[index] == '--state':
            if chosen is not None or index+1 >= len(args): raise ValueError('--state 需要唯一状态路径')
            index += 1; chosen = args[index]
            if not chosen: raise ValueError('--state 路径不能为空')
        else: positional.append(args[index])
        index += 1
    base = positional.pop(0) if positional and re.match(r'^https?://', positional[0]) else BASE
    base = base.rstrip('/')
    if not positional: raise ValueError(help_text(curl))
    token_path = str(Path(positional.pop(0)).resolve(strict=True))
    token = Path(token_path).read_text().strip()
    if not re.fullmatch(r'lm_[0-9a-f]{64}', token): raise ValueError('Token格式无效')
    if chosen is None and positional and positional[0].endswith('.upload-state'): chosen = positional.pop(0)
    if chosen:
        state = Path(chosen).absolute()
    else:
        if not positional: raise ValueError('首次至少一张JPEG；恢复使用 --state')
        folder = Path.home()/'.lookme-upload-batches'
        if folder.is_symlink(): raise ValueError('状态目录不能是符号链接')
        if not folder.exists(): folder.mkdir(mode=0o700)
        state = folder/(('curl' if curl else 'py')+'-batch-'+str(uuid.uuid4())+'.upload-state')
    if state.is_symlink(): raise ValueError('状态不能是符号链接')
    if os.name != 'nt' and state.parent.stat().st_mode & 0o077: raise ValueError('状态父目录必须受限（0700）')
    lock = Path(str(state)+'.lock')
    lock.mkdir(mode=0o700)
    try:
        if state.exists():
            data = json.loads(state.read_text())
            if data.get('format') != 'LOOKME_NATIVE_BATCH_V1' or data.get('base_url') != base or data.get('token_path') != token_path:
                raise ValueError('状态格式、服务地址或Token文件路径与原批次不一致')
            jobs = data['jobs']
            if not jobs or len(jobs)>10000: raise ValueError('状态记录无效')
            ids, paths = set(), set()
            for job in jobs:
                if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', job['uuid']) or job['uuid'] in ids or job['path'] in paths:
                    raise ValueError('状态UUID/路径重复或无效')
                ids.add(job['uuid']); paths.add(job['path']); verify(job)
        else:
            if not positional: raise ValueError('新批次至少一张JPEG')
            paths = [str(Path(file).resolve(strict=True)) for file in positional]
            if len(set(paths)) != len(paths): raise ValueError('重复图片路径')
            jobs = []
            for file in paths:
                stat = Path(file).stat()
                if not Path(file).is_file() or not 0 < stat.st_size <= 2*1024*1024: raise ValueError('图片为空/过大/不是普通文件：'+file)
                jobs.append(dict(path=file, uuid=str(uuid.uuid4()), size=stat.st_size, modified=str(stat.st_mtime_ns), status=0, response=''))
            data = dict(format='LOOKME_NATIVE_BATCH_V1', base_url=base, token_path=token_path, jobs=jobs)
        if positional and [str(Path(f).resolve(strict=True)) for f in positional] != [job['path'] for job in data['jobs']]: raise ValueError('恢复图片列表/顺序改变')
        save_state(state, data)
        print('STATE_FILE='+str(state), flush=True)
        return state, lock, data, token
    except BaseException:
        lock.rmdir(); raise


def multipart(job):
    boundary = uuid.uuid4().hex
    fields = []
    for name, value in [('client_photo_id', job['uuid']), ('source', 'cli')]:
        fields.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    fields.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()+Path(job['path']).read_bytes()+b'\r\n')
    fields.append(f'--{boundary}--\r\n'.encode())
    return b''.join(fields), boundary


def connection(base):
    target = urlsplit(base)
    if target.scheme not in ('http', 'https') or not target.hostname or target.username: raise ValueError('需要合法HTTP(S)服务地址')
    proxy = None
    if target.hostname not in ('127.0.0.1', 'localhost', '::1') and not proxy_bypass_environment(target.hostname):
        proxy = os.environ.get(target.scheme+'_proxy') or os.environ.get(target.scheme.upper()+'_PROXY')
    host, port = target.hostname, target.port
    path = (target.path.rstrip('/')+'/photos') or '/photos'
    if proxy:
        parsed = urlsplit(proxy)
        if parsed.scheme != 'http' or not parsed.hostname: raise ValueError('Python持久连接目前只支持HTTP代理，其他代理请用curl/C')
        headers = {}
        if parsed.username is not None:
            value = unquote(parsed.username)+':'+unquote(parsed.password or '')
            headers['Proxy-Authorization'] = 'Basic '+base64.b64encode(value.encode()).decode()
        if target.scheme == 'https':
            conn = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=30, context=ssl.create_default_context())
            conn.set_tunnel(host, port or 443, headers=headers)
        else:
            conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=30)
            path = base+'/photos'
        return conn, path, headers if target.scheme == 'http' else {}
    conn = http.client.HTTPSConnection(host, port, timeout=30, context=ssl.create_default_context()) if target.scheme == 'https' else http.client.HTTPConnection(host, port, timeout=30)
    return conn, path, {}


def summary(job, seconds, speed, completed, total, scope):
    print(f"{'上传成功' if job['status'] in SUCCESS else '上传失败'}：{job['path']}\nCLIENT_PHOTO_ID={job['uuid']} HTTP {job['status']}\n文件大小：{job['size']} 字节，请求耗时：{seconds:.3f} 秒，平均上传速度：{speed:.2f} KiB/s（{scope}）\n服务端响应：{job['response']}\n批次进度：已成功 {completed}/{total}", flush=True)


def python_upload(state, data, token, stopped):
    pending = queue.Queue()
    for job in data['jobs']:
        if job['status'] not in SUCCESS: pending.put(job)
    guard = threading.Lock()
    completed = sum(j['status'] in SUCCESS for j in data['jobs'])
    uploaded = 0
    def worker():
        nonlocal completed, uploaded
        conn, request_path, proxy_headers = connection(data['base_url'])
        try:
            while not stopped.is_set():
                try: job = pending.get_nowait()
                except queue.Empty: break
                verify(job)
                print('开始：'+job['path']+' CLIENT_PHOTO_ID='+job['uuid'], flush=True)
                start = time.perf_counter()
                try:
                    body, boundary = multipart(job)
                    conn.request('POST', request_path, body=body, headers={**proxy_headers, 'Authorization':'Bearer '+token, 'Content-Type':'multipart/form-data; boundary='+boundary})
                    response = conn.getresponse()
                    raw = response.read(65537)
                    if len(raw)>65536: raise ValueError('响应过大')
                    status, text = response.status, raw.decode('utf8', errors='replace')
                    response.close()
                except Exception:
                    conn.close(); status, text = -1, '网络/传输未确认；复用UUID恢复'
                elapsed = time.perf_counter()-start
                with guard:
                    job['status'], job['response'] = status, text
                    if status in SUCCESS: completed += 1; uploaded += job['size']
                    save_state(state, data)
                    summary(job, elapsed, job['size']/1024/elapsed if elapsed else 0, completed, len(data['jobs']), '含服务端处理')
        finally: conn.close()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(worker) for _ in range(min(8, pending.qsize()))]
        try:
            for future in futures: future.result()
        except BaseException:
            stopped.set(); raise
    return completed, uploaded


def curl_upload(state, data, token, stopped):
    jobs = [j for j in data['jobs'] if j['status'] not in SUCCESS]
    completed = len(data['jobs'])-len(jobs)
    uploaded = 0
    if not jobs: return completed, uploaded
    with tempfile.TemporaryDirectory(prefix='lookme-curl-batch-') as folder:
        root = Path(folder)
        header = root/'headers'
        header.write_text('Authorization: Bearer '+token+'\n'); header.chmod(0o600)
        lines = []
        for index, job in enumerate(jobs):
            verify(job)
            if index: lines.append('next')
            file_path = job['path'].replace('\\', '\\\\').replace('"', '\\"')
            options = [('url', data['base_url']+'/photos'), ('header', '@'+str(header)),
                       ('form', 'file=@"'+file_path+'";type=image/jpeg'), ('form-string', 'client_photo_id='+job['uuid']),
                       ('form-string', 'source=cli'), ('output', str(root/f'{index}.response')),
                       ('max-time', '30'), ('connect-timeout', '10'), ('max-filesize', '65536'),
                       ('write-out', f'{{"index":{index},"status":"%{{http_code}}","seconds":%{{time_total}},"speed":%{{speed_upload}},"exitcode":%{{exitcode}}}}\n')]
            lines.extend(key+' = '+json.dumps(value, ensure_ascii=False) for key,value in options)
        config = root/'curl.conf'
        config.write_text('\n'.join(lines)+'\n'); config.chmod(0o600)
        print('开始：curl parallel 批次，最多8并发', flush=True)
        process = subprocess.Popen(['curl','-q','--parallel','--parallel-max','8','--silent','--show-error','--config',str(config)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        old_handler = signal.getsignal(signal.SIGTERM)
        def stop(signum, frame): stopped.set(); process.terminate()
        signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
        try:
            for line in process.stdout:
                metric = json.loads(line)
                job = jobs[metric['index']]
                job['status'] = int(metric['status']) if metric['exitcode']==0 else -1
                file = root/f"{metric['index']}.response"
                job['response'] = file.read_text(errors='replace') if file.exists() else '传输未确认'
                if job['status'] in SUCCESS: completed+=1; uploaded+=job['size']
                save_state(state, data)
                summary(job, metric['seconds'], metric['speed']/1024, completed, len(data['jobs']), 'curl统计，含multipart')
            process.wait(timeout=5)
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            signal.signal(signal.SIGTERM, old_handler)
    return completed, uploaded


def main():
    args = sys.argv[1:]
    curl = bool(args and args[0]=='--curl')
    if curl: args.pop(0)
    prepared = prepare(args, curl)
    if prepared is None: return 0
    state, lock, data, token = prepared
    stopped = threading.Event()
    def stop(signum, frame): stopped.set()
    old_int, old_term = signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    began = time.perf_counter()
    try:
        completed, uploaded = curl_upload(state,data,token,stopped) if curl else python_upload(state,data,token,stopped)
        elapsed = time.perf_counter()-began
        print(f'批次进度：已成功 {completed}/{len(data["jobs"])}\n批次耗时：{elapsed:.3f} 秒，本次成功文件：{uploaded} 字节，有效平均速率：{uploaded/1024/elapsed if elapsed else 0:.2f} KiB/s\n状态文件：{state}')
        if stopped.is_set(): print('批次已中断；使用 --state 恢复或核对原状态。', file=sys.stderr)
        return 0 if completed==len(data['jobs']) and not stopped.is_set() else 1
    finally:
        signal.signal(signal.SIGINT, old_int); signal.signal(signal.SIGTERM, old_term)
        lock.rmdir()


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as error:
        print('批次未全部确认成功：'+str(error)+'\n使用 --state 恢复已输出的原状态。', file=sys.stderr)
        sys.exit(1)
