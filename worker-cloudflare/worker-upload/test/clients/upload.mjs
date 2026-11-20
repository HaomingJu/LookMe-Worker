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
