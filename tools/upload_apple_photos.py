#!/usr/bin/env python3
"""读取 macOS 照片的拍摄时间，转为合规 JPEG 后批量上传到 LookMe。

走已部署的 POST /photos：owner 由服务端按 Token 鉴权得出，本脚本不接触
D1 或 R2。拍摄时间取自 mdls 的内容创建时间，缺失时回退到文件创建时间并
显式标注来源，绝不把上传时间当作拍摄时间。
"""
import http.client
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlsplit

BASE = 'https://api.fudaixuexue.eu.cc'
SUCCESS = (200, 201)
IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.gif', '.webp'}
LONG_EDGE = 1600          # 长边像素；短边等比，不放大小图
QUALITY = 80              # sips formatOptions，0–100
MAX_BYTES = 2 * 1024 * 1024
MIN_QUALITY = 40
UUID_RE = r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
MDLS_DATE = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$')


def help_text():
    return f'''读取 macOS 照片目录，记录拍摄时间并转为 JPEG 后上传。

用法：python3 upload_apple_photos.py [--dry-run] [BASE_URL] TOKEN_FILE 目录
暂存：python3 upload_apple_photos.py --stage 输出目录 源目录
上传：python3 upload_apple_photos.py --from 暂存目录 [BASE_URL] TOKEN_FILE
恢复：python3 upload_apple_photos.py --state STATE_FILE [BASE_URL] TOKEN_FILE
帮助：python3 upload_apple_photos.py --help

BASE_URL 可选，默认 {BASE}；TOKEN_FILE 是凭据文件路径，不是 Token 明文。
目录递归扫描 jpg/jpeg/png/heic/heif/tif/tiff/gif/webp，按路径排序，最多 10000 张。
--dry-run 只做转换与时间解析并打印结果，不创建状态、不上传。

--stage 把每张转成可上传的 JPEG 连同原始信息存进输出目录（0001.jpg、0001.json…），
不需要 Token、不上传。JSON 记录原路径、拍摄时间与来源、原图与成品的尺寸和字节数。
检查无误后用 --from 上传该目录：复用其中的 JPEG 和 client_photo_id，不再重新转换，
因此上传内容与检查时看到的完全一致。输出目录必须尚不存在。

每张：sips 应用方向、转 sRGB JPEG、长边不超过 {LONG_EDGE}px（不放大）、质量 {QUALITY}；
超过 2 MiB 时继续降质量，降到 {MIN_QUALITY} 仍超限则跳过该张。
GPS 与其他 EXIF 在转换时丢弃，不随文件上传。

拍摄时间优先用 mdls 的内容创建时间（来源 apple_photos），没有时用文件创建时间
（来源 device）并明确标注；两者都没有则不上传时间字段，不用当前时间冒充。

--state 省略时在主目录 .lookme-upload-batches 新建状态（目录 0700、文件 0600），
保存每张的 UUID、拍摄时间与来源、完成状态；失败用 --state 恢复，UUID 不变。
最多 8 个线程各持一条持久连接。退出 0 全部成功，退出 1 有失败或被跳过。'''


def save_state(path, data):
    temp = Path(str(path) + '.tmp')
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
        if created and temp.exists():
            temp.unlink()


def option(args, index, seen, name):
    """取 --name 后的唯一值，重复或缺少都报错。"""
    if name in seen or index + 1 >= len(args) or not args[index + 1] or args[index + 1].startswith('--'):
        raise ValueError(name + ' 需要唯一参数')
    seen.add(name)
    return args[index + 1]


def parse_args(args):
    """返回 (dry_run, state, stage_out, staged_in, base, token_path, directory)。

    token_path 与 directory 为 None 表示该模式不使用它们。
    """
    dry_run, state, stage_out, staged_in, seen, positional = False, None, None, None, set(), []
    index = 0
    while index < len(args):
        item = args[index]
        if item == '--dry-run':
            dry_run = True
        elif item == '--state':
            state = option(args, index, seen, '--state')
            index += 1
        elif item == '--stage':
            stage_out = option(args, index, seen, '--stage')
            index += 1
        elif item == '--from':
            staged_in = option(args, index, seen, '--from')
            index += 1
        elif item.startswith('--'):
            raise ValueError('未知参数：' + item)
        else:
            positional.append(item)
        index += 1
    modes = [stage_out is not None, staged_in is not None, state is not None]
    if sum(modes) > 1 or (dry_run and any(modes)):
        raise ValueError('--stage、--from、--state、--dry-run 只能选一个')
    base = positional.pop(0).rstrip('/') if positional and re.match(r'^https?://', positional[0]) else BASE
    token_path = directory = None
    if stage_out is not None:
        if len(positional) != 1:
            raise ValueError('--stage 只需要源目录，不需要 Token')
        directory = str(Path(positional[0]).resolve(strict=True))
    elif positional:
        token_path = str(Path(positional.pop(0)).resolve(strict=True))
        if len(positional) > 1:
            raise ValueError('只接受一个目录')
        if positional:
            directory = str(Path(positional[0]).resolve(strict=True))
    elif not state:
        raise ValueError(help_text())
    return dry_run, state, stage_out, staged_in, base, token_path, directory


def read_token(token_path):
    token = Path(token_path).read_text().strip()
    if not re.fullmatch(r'lm_[0-9a-f]{64}', token):
        raise ValueError('Token 格式无效')
    return token


def scan(directory):
    root = Path(directory)
    if not root.is_dir():
        raise ValueError('不是目录：' + directory)
    found = [p for p in root.rglob('*') if p.is_file() and not p.is_symlink() and p.suffix.lower() in IMAGE_SUFFIXES]
    found.sort()
    if not found:
        raise ValueError('目录中没有支持的图片：' + directory)
    if len(found) > 10000:
        raise ValueError('图片超过 10000 张')
    return [str(p) for p in found]


def captured_time(path):
    """返回 (RFC3339 或 None, 来源或 None)。来源与时间严格成对。"""
    try:
        out = subprocess.run(['mdls', '-raw', '-name', 'kMDItemContentCreationDate', path],
                             capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        out = ''
    if MDLS_DATE.match(out):
        moment = datetime.strptime(out, '%Y-%m-%d %H:%M:%S %z')
        return moment.isoformat(timespec='seconds'), 'apple_photos'
    created = os.stat(path).st_birthtime
    if created:
        moment = datetime.fromtimestamp(created, timezone.utc).astimezone()
        return moment.isoformat(timespec='seconds'), 'device'
    return None, None


def pixel_size(path):
    """返回 (宽, 高)；sips 读不到时抛错。"""
    probe = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path],
                           capture_output=True, text=True, timeout=60)
    dims = [int(n) for n in re.findall(r'pixel(?:Width|Height): (\d+)', probe.stdout)]
    if probe.returncode != 0 or len(dims) != 2 or not all(dims):
        raise ValueError('sips 读不到尺寸：' + path)
    return dims[0], dims[1]


def render_jpeg(src, dest):
    """转 sRGB JPEG、应用方向、限制长边。返回字节数；无法压到上限时抛错。"""
    longest = max(pixel_size(src))
    quality = QUALITY
    while True:
        cmd = ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', str(quality), src, '--out', dest]
        if longest > LONG_EDGE:
            cmd[1:1] = ['-Z', str(LONG_EDGE)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0 or not Path(dest).is_file():
            raise ValueError('sips 转换失败：' + src)
        size = Path(dest).stat().st_size
        if size <= MAX_BYTES:
            return size
        if quality <= MIN_QUALITY:
            raise ValueError(f'降到质量 {MIN_QUALITY} 仍超过 2 MiB：' + src)
        quality -= 10


def stage(out_dir, directory):
    """把可上传的 JPEG 和对应信息存进新建目录，不上传。返回 (成功数, 跳过数)。"""
    out = Path(out_dir)
    if out.exists() or out.is_symlink():
        raise ValueError('输出目录必须尚不存在：' + out_dir)
    out.mkdir()
    made = skipped = 0
    try:
        for path in scan(directory):
            when, origin = captured_time(path)
            name = f'{made + skipped + 1:04d}'
            dest = out / (name + '.jpg')
            try:
                size = render_jpeg(path, str(dest))
                width, height = pixel_size(str(dest))
            except ValueError as error:
                dest.unlink(missing_ok=True)
                skipped += 1
                print(f'跳过：{error}', flush=True)
                continue
            info = dict(source_path=path, client_photo_id=str(uuid.uuid4()),
                        captured_at=when, captured_at_source=origin,
                        source_bytes=os.stat(path).st_size,
                        jpeg_bytes=size, width=width, height=height)
            (out / (name + '.json')).write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
            made += 1
            print(f'{name}.jpg ← {path}\n拍摄时间：{when or "未知"}（来源 {origin or "无"}），'
                  f'{width}×{height}，{size} 字节', flush=True)
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)
        raise
    print(f'已暂存 {made} 张到 {out.resolve()}，跳过 {skipped}。检查后用 --from 上传。')
    return made, skipped


def load_staged(directory):
    """读取 --stage 产物，校验 JPEG 与记录一致。返回可直接上传的 jobs。"""
    root = Path(directory).resolve()
    if not root.is_dir():
        raise ValueError('不是目录：' + directory)
    jobs = []
    for meta in sorted(root.glob('*.json')):
        info = json.loads(meta.read_text())
        photo = meta.with_suffix('.jpg')
        client_id = info.get('client_photo_id')
        if not photo.is_file() or not re.fullmatch(UUID_RE, client_id or ''):
            raise ValueError('暂存记录缺少 JPEG 或 UUID：' + meta.name)
        if photo.stat().st_size != info.get('jpeg_bytes'):
            raise ValueError('JPEG 与记录的字节数不符，可能被改动：' + photo.name)
        jobs.append(dict(path=str(photo), uuid=client_id, jpeg_ready=True,
                          captured_at=info.get('captured_at'), captured_at_source=info.get('captured_at_source'),
                          status=0, response=''))
    if not jobs:
        raise ValueError('暂存目录里没有记录')
    return jobs


def prepare(args):
    if args == ['--help']:
        print(help_text())
        return None
    dry_run, chosen, stage_out, staged_in, base, token_path, directory = parse_args(args)

    if stage_out is not None:
        made, skipped = stage(stage_out, directory)
        return ('staged', made, skipped)

    token = read_token(token_path)

    if dry_run:
        if not directory:
            raise ValueError('--dry-run 需要目录')
        work = tempfile.mkdtemp(prefix='lookme-apple-')
        try:
            for path in scan(directory):
                when, origin = captured_time(path)
                try:
                    size = render_jpeg(path, str(Path(work) / (uuid.uuid4().hex + '.jpg')))
                    print(f'可上传：{path}\n拍摄时间：{when or "未知"}（来源 {origin or "无"}），转换后 {size} 字节', flush=True)
                except ValueError as error:
                    print(f'跳过：{error}', flush=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return None

    if chosen:
        state = Path(chosen).absolute()
    else:
        if not directory:
            raise ValueError('首次需要目录；恢复使用 --state')
        folder = Path.home() / '.lookme-upload-batches'
        if folder.is_symlink():
            raise ValueError('状态目录不能是符号链接')
        if not folder.exists():
            folder.mkdir(mode=0o700)
        state = folder / ('apple-' + str(uuid.uuid4()) + '.upload-state')
    if state.is_symlink():
        raise ValueError('状态不能是符号链接')
    if os.name != 'nt' and state.parent.stat().st_mode & 0o077:
        raise ValueError('状态父目录必须受限（0700）')
    lock = Path(str(state) + '.lock')
    lock.mkdir(mode=0o700)
    try:
        if state.exists():
            data = json.loads(state.read_text())
            if data.get('format') != 'LOOKME_APPLE_BATCH_V1' or data.get('base_url') != base or data.get('token_path') != token_path:
                raise ValueError('状态格式、服务地址或 Token 文件路径与原批次不一致')
            jobs = data['jobs']
            if not jobs or len(jobs) > 10000:
                raise ValueError('状态记录无效')
            seen = set()
            for job in jobs:
                if not re.fullmatch(UUID_RE, job['uuid']) or job['uuid'] in seen or job['path'] in seen:
                    raise ValueError('状态 UUID 或路径重复、无效')
                seen.update((job['uuid'], job['path']))
                if not Path(job['path']).is_file():
                    raise ValueError('原图片不存在：' + job['path'])
        else:
            if staged_in is not None:
                jobs = load_staged(staged_in)
            elif directory:
                jobs = []
                for path in scan(directory):
                    when, origin = captured_time(path)
                    stat = os.stat(path)
                    jobs.append(dict(path=path, uuid=str(uuid.uuid4()), source_size=stat.st_size,
                                      captured_at=when, captured_at_source=origin, status=0, response=''))
            else:
                raise ValueError('首次需要目录或 --from；恢复使用 --state')
            data = dict(format='LOOKME_APPLE_BATCH_V1', base_url=base, token_path=token_path, jobs=jobs)
        save_state(state, data)
        print('STATE_FILE=' + str(state), flush=True)
        return state, lock, data, token
    except BaseException:
        lock.rmdir()
        raise


def multipart(job, jpeg):
    boundary = uuid.uuid4().hex
    fields = [('client_photo_id', job['uuid']), ('source', 'apple_app')]
    if job['captured_at']:
        fields += [('captured_at', job['captured_at']), ('captured_at_source', job['captured_at_source'])]
    chunks = [b''.join((b'--', boundary.encode(), b'\r\nContent-Disposition: form-data; name="', name.encode(), b'"\r\n\r\n', value.encode(), b'\r\n')) for name, value in fields]
    chunks.append(b'--' + boundary.encode() + b'\r\nContent-Disposition: form-data; name="file"; filename="upload.jpg"\r\nContent-Type: image/jpeg\r\n\r\n' + jpeg + b'\r\n')
    chunks.append(b'--' + boundary.encode() + b'--\r\n')
    return b''.join(chunks), boundary


def connection(base):
    target = urlsplit(base)
    if target.scheme not in ('http', 'https') or not target.hostname or target.username or target.query:
        raise ValueError('需要合法 HTTP(S) 服务地址')
    path = (target.path.rstrip('/') + '/photos') or '/photos'
    port = target.port
    if target.scheme == 'https':
        return http.client.HTTPSConnection(target.hostname, port, timeout=60, context=ssl.create_default_context()), path
    return http.client.HTTPConnection(target.hostname, port, timeout=60), path


def upload(state, data, token, stopped):
    pending = queue.Queue()
    for job in data['jobs']:
        if job['status'] not in SUCCESS:
            pending.put(job)
    guard = threading.Lock()
    completed = sum(j['status'] in SUCCESS for j in data['jobs'])
    skipped = 0

    def worker():
        nonlocal completed, skipped
        conn, request_path = connection(data['base_url'])
        work = tempfile.mkdtemp(prefix='lookme-apple-')
        try:
            while not stopped.is_set():
                try:
                    job = pending.get_nowait()
                except queue.Empty:
                    break
                ready = job.get('jpeg_ready')
                dest = job['path'] if ready else str(Path(work) / (job['uuid'] + '.jpg'))
                print('开始：' + job['path'] + ' CLIENT_PHOTO_ID=' + job['uuid'], flush=True)
                start = time.perf_counter()
                try:
                    size = Path(dest).stat().st_size if ready else render_jpeg(job['path'], dest)
                    body, boundary = multipart(job, Path(dest).read_bytes())
                    conn.request('POST', request_path, body=body, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
                    response = conn.getresponse()
                    raw = response.read(65537)
                    if len(raw) > 65536:
                        raise ValueError('响应过大')
                    status, text = response.status, raw.decode('utf8', errors='replace')
                    response.close()
                except ValueError as error:
                    status, text, size = -2, str(error), 0
                except (http.client.HTTPException, OSError, TimeoutError):
                    conn.close()
                    status, text, size = -1, '网络/传输未确认；复用 UUID 恢复', 0
                elapsed = time.perf_counter() - start
                with guard:
                    job['status'], job['response'] = status, text
                    if status in SUCCESS:
                        completed += 1
                    elif status == -2:
                        skipped += 1
                    save_state(state, data)
                outcome = '上传成功' if status in SUCCESS else ('已跳过' if status == -2 else '上传失败')
                print(f'{outcome}：{job["path"]}\nCLIENT_PHOTO_ID={job["uuid"]} HTTP {status}，转换后 {size} 字节，耗时 {elapsed:.3f} 秒\n'
                      f'拍摄时间：{job["captured_at"] or "未知"}（来源 {job["captured_at_source"] or "无"}）\n服务端响应：{text}\n'
                      f'批次进度：已成功 {completed}/{len(data["jobs"])}', flush=True)
        finally:
            conn.close()
            shutil.rmtree(work, ignore_errors=True)

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(worker) for _ in range(min(8, pending.qsize()))]
        try:
            for future in futures:
                future.result()
        except BaseException:
            stopped.set()
            raise
    return completed, skipped


def main():
    if not shutil.which('sips') or not shutil.which('mdls'):
        raise SystemExit('需要 macOS 的 sips 与 mdls')
    prepared = prepare(sys.argv[1:])
    if prepared is None:
        return 0
    if prepared[0] == 'staged':
        return 0 if prepared[2] == 0 else 1
    state, lock, data, token = prepared
    stopped = threading.Event()

    def stop(signum, frame):
        stopped.set()

    old_int, old_term = signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        completed, skipped = upload(state, data, token, stopped)
        total = len(data['jobs'])
        print(f'批次进度：已成功 {completed}/{total}，跳过 {skipped}\n状态文件：{state}')
        if stopped.is_set():
            print('批次已中断；使用 --state 恢复原状态。', file=sys.stderr)
        return 0 if completed == total and not stopped.is_set() else 1
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)
        lock.rmdir()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('批次未全部确认成功：' + str(error) + '\n使用 --state 恢复已输出的原状态。', file=sys.stderr)
        sys.exit(1)
