import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import { Store, StoreError, isValidId } from './lib/store.js';
import {
  docker, composeArgs, parsePsOutput, normalizeContainer, ExecError, DOCKER_BIN,
} from './lib/docker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.CYPHER_DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ACCESS_TOKEN = process.env.CYPHER_TOKEN || '';
const MAX_UPLOAD = Number(process.env.CYPHER_MAX_UPLOAD_MB || 4096) * 1024 * 1024;

const store = new Store(DATA_DIR);
const locks = new Map();

/* ------------------------------------------------------------------ utils */

class HttpError extends Error {
  constructor(message, status = 400, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError('请求体过大', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError('请求体不是合法的 JSON', 400);
  }
}

/** Serialise mutating operations per application. */
async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function requireToken(req) {
  if (!ACCESS_TOKEN) return;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('cypher_token='));
  const fromCookie = cookie ? decodeURIComponent(cookie.split('=').slice(1).join('=')) : '';
  const provided = bearer || fromCookie || String(req.headers['x-cypher-token'] || '');

  const a = Buffer.from(provided);
  const b = Buffer.from(ACCESS_TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) throw new HttpError('需要访问令牌', 401);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const type = CONTENT_TYPES[path.extname(target)] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}

/* ------------------------------------------------------------- app helpers */

async function loadApp(id) {
  if (!isValidId(id)) throw new HttpError('非法的应用 ID', 400);
  try {
    return await store.read(id);
  } catch (err) {
    if (err instanceof StoreError) throw new HttpError(err.message, err.status);
    throw err;
  }
}

async function composeContext(id) {
  const app = await loadApp(id);
  if (app.missing) {
    throw new HttpError(`部署目录不存在：${app.deployPath}`, 409);
  }
  if (!app.composeFile) {
    throw new HttpError('该应用还没有 docker-compose 文件', 409);
  }
  const composePath = path.join(app.deployPath, app.composeFile);
  return { app, composePath };
}

function runCompose(composePath, app, extra, opts = {}) {
  return docker(composeArgs(composePath, app.deployPath, app.id, extra), {
    cwd: app.deployPath,
    timeout: opts.timeout ?? 180_000,
  });
}

async function collectStatus(app, composePath) {
  const [{ stdout }, configResult] = await Promise.all([
    runCompose(composePath, app, ['ps', '--all', '--format', 'json'], { timeout: 30_000 }),
    runCompose(composePath, app, ['config', '--services'], { timeout: 30_000 })
      .catch(() => ({ stdout: '' })),
  ]);
  const containers = parsePsOutput(stdout).map(normalizeContainer);
  const services = configResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { containers, services };
}

/* ------------------------------------------------------------------ routes */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // GET /api/system — capability check
  if (parts[1] === 'system' && parts.length === 2 && method === 'GET') {
    let dockerVersion = null;
    let composeVersion = null;
    let daemon = false;
    try {
      const v = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
      dockerVersion = v.stdout.trim();
      daemon = true;
    } catch { /* daemon unavailable */ }
    try {
      const c = await docker(['compose', 'version', '--short'], { timeout: 15_000 });
      composeVersion = c.stdout.trim();
    } catch { /* compose unavailable */ }
    sendJson(res, 200, { dockerVersion, composeVersion, daemon, dataDir: DATA_DIR, host: os.hostname() });
    return;
  }

  // GET /api/images — local images
  if (parts[1] === 'images' && parts.length === 2 && method === 'GET') {
    const { stdout } = await docker([
      'images', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}',
    ], { timeout: 30_000 });
    const images = stdout.split('\n').filter(Boolean).map((line) => {
      const [repository, tag, id, size, created] = line.split('\t');
      return { repository, tag, id, size, created };
    });
    sendJson(res, 200, { images });
    return;
  }

  if (parts[1] !== 'apps') {
    throw new HttpError('Not found', 404);
  }

  // /api/apps
  if (parts.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, { apps: await store.list() });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const app = await store.create(body);
        sendJson(res, 201, { app });
      } catch (err) {
        if (err instanceof StoreError) throw new HttpError(err.message, err.status);
        throw err;
      }
      return;
    }
    throw new HttpError('Method not allowed', 405);
  }

  const id = parts[2];

  // /api/apps/:id
  if (parts.length === 3) {
    if (method === 'GET') {
      const app = await loadApp(id);
      let status = { containers: [], services: [] };
      if (app.composeFile && !app.missing) {
        try {
          status = await collectStatus(app, path.join(app.deployPath, app.composeFile));
        } catch { /* report app even if docker is unhappy */ }
      }
      sendJson(res, 200, { app, ...status });
      return;
    }
    if (method === 'PATCH') {
      await loadApp(id);
      const body = await readJsonBody(req);
      const moving = body.deployPath !== undefined && String(body.deployPath).trim() !== '';
      try {
        let app;
        if (moving) {
          app = await withLock(`app:${id}`, async () => {
            const target = await store.read(id);
            // Containers bind to their absolute working directory, so stop
            // them before the directory moves.
            if (target.composeFile && !target.missing) {
              try {
                await runCompose(path.join(target.deployPath, target.composeFile), target,
                  ['down', '--remove-orphans'], { timeout: 120_000 });
              } catch { /* best effort */ }
            }
            return store.updateMeta(id, body);
          });
        } else {
          app = await store.updateMeta(id, body);
        }
        sendJson(res, 200, { app });
      } catch (err) {
        if (err instanceof StoreError) throw new HttpError(err.message, err.status);
        throw err;
      }
      return;
    }
    if (method === 'DELETE') {
      await loadApp(id);
      const result = await withLock(`app:${id}`, async () => {
        const target = await store.read(id);
        if (target.composeFile && !target.missing) {
          try {
            await runCompose(path.join(target.deployPath, target.composeFile), target,
              ['down', '--remove-orphans'], { timeout: 120_000 });
          } catch { /* best effort */ }
        }
        return store.remove(id);
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    throw new HttpError('Method not allowed', 405);
  }

  // /api/apps/:id/files/:name
  if (parts[3] === 'files' && parts.length === 5) {
    const name = decodeURIComponent(parts[4]);
    if (name !== 'compose' && name !== 'env') throw new HttpError('未知文件', 404);
    const app = await loadApp(id);
    const fileName = name === 'compose'
      ? (app.composeFile || 'docker-compose.yml')
      : '.env';

    if (method === 'GET') {
      const app = await loadApp(id);
      const content = app.missing ? '' : await store.readFile(id, fileName);
      sendJson(res, 200, {
        name: fileName,
        content: content ?? '',
        missing: app.missing,
        deployPath: app.deployPath,
      });
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      try {
        await store.writeFile(id, fileName, body.content);
      } catch (err) {
        if (err instanceof StoreError) throw new HttpError(err.message, err.status);
        throw err;
      }
      sendJson(res, 200, { ok: true, name: fileName });
      return;
    }
    throw new HttpError('Method not allowed', 405);
  }

  // /api/apps/:id/images — upload a `docker save` tarball
  if (parts[3] === 'images' && parts.length === 4 && method === 'PUT') {
    const app = await loadApp(id);
    const fileName = String(url.searchParams.get('filename') || 'image.tar');
    if (!/\.(tar|tar\.gz|tgz|tar\.zst)$/i.test(fileName)) {
      throw new HttpError('请上传 .tar / .tar.gz / .tgz 格式的镜像归档', 400);
    }
    const temp = store.tmpPath();
    await fsp.mkdir(path.dirname(temp), { recursive: true });

    await withLock(`app:${id}`, async () => {
      let written = 0;
      const out = fs.createWriteStream(temp);
      try {
        for await (const chunk of req) {
          written += chunk.length;
          if (written > MAX_UPLOAD) throw new HttpError('镜像文件超过大小上限', 413);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((resolve, reject) => {
          out.end((err) => (err ? reject(err) : resolve()));
        });
        if (written === 0) throw new HttpError('上传内容为空', 400);
        const result = await docker(['load', '--input', temp], { timeout: 600_000 });
        const text = `${result.stdout}\n${result.stderr}`;
        const loaded = [...text.matchAll(/Loaded image(?:\s+ID)?:\s*(\S+)/g)]
          .map((m) => m[1].replace(/^sha256:/, ''));
        const named = [...text.matchAll(/Loaded image:\s*(\S+)/g)].map((m) => m[1]);
        sendJson(res, 200, {
          ok: true,
          images: loaded,
          names: named,
          output: text.trim(),
        });
        return;
      } finally {
        out.destroy();
        await fsp.rm(temp, { force: true }).catch(() => {});
      }
    });
    return;
  }

  // /api/apps/:id/actions/:action
  if (parts[3] === 'actions' && parts.length === 5 && method === 'POST') {
    const action = parts[4];
    const { app, composePath } = await composeContext(id);

    const allowed = {
      up: { args: ['up', '-d', '--remove-orphans'], timeout: 300_000 },
      down: { args: ['down', '--remove-orphans'], timeout: 180_000 },
      restart: { args: ['restart'], timeout: 180_000 },
      stop: { args: ['stop'], timeout: 180_000 },
      build: { args: ['build'], timeout: 900_000 },
      pull: { args: ['pull'], timeout: 900_000 },
    };
    if (!allowed[action]) throw new HttpError('未知操作', 404);

    const result = await withLock(`app:${id}`, async () => {
      try {
        return await runCompose(composePath, app, allowed[action].args,
          { timeout: allowed[action].timeout });
      } catch (err) {
        if (err instanceof ExecError) {
          throw new HttpError(err.message.split('\n').slice(-8).join('\n'), 500, {
            stdout: err.detail?.stdout,
            stderr: err.detail?.stderr,
          });
        }
        throw err;
      }
    });

    let status = { containers: [], services: [] };
    try {
      status = await collectStatus(app, composePath);
    } catch { /* ignore */ }

    sendJson(res, 200, {
      ok: true,
      action,
      output: `${result.stdout}${result.stderr}`.trim(),
      ...status,
    });
    return;
  }

  // /api/apps/:id/logs
  if (parts[3] === 'logs' && parts.length === 4 && method === 'GET') {
    const { app, composePath } = await composeContext(id);
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 200, 10), 5000);
    const service = url.searchParams.get('service');
    const extra = ['logs', '--no-color', '--tail', String(tail)];
    if (service && /^[a-zA-Z0-9._-]+$/.test(service)) extra.push(service);
    const result = await runCompose(composePath, app, extra, { timeout: 30_000 })
      .catch((err) => ({ stdout: '', stderr: err.message }));
    sendJson(res, 200, { logs: `${result.stdout}${result.stderr}` });
    return;
  }

  throw new HttpError('Not found', 404);
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  // Never build the base from the Host header: a Host carrying a URL-illegal
  // character makes `new URL` throw ERR_INVALID_URL, and a throw here happens
  // before the try block below, so it surfaces as an unhandled rejection and
  // kills the process. Any client able to reach the port could do that without
  // a token. Only pathname and searchParams are ever read, so a fixed base is
  // enough.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    sendJson(res, 400, { error: '请求路径无法解析' });
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET,POST,PUT,PATCH,DELETE' });
        res.end();
        return;
      }
      requireToken(req);
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, detail: err.detail });
      return;
    }
    if (err instanceof ExecError) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    console.error('[cypher]', err);
    sendJson(res, 500, { error: err.message || '服务器内部错误' });
  }
});

server.headersTimeout = 0;
server.requestTimeout = 0;

await store.init();

server.listen(PORT, HOST, () => {
  console.log(`cypher 已启动: http://${HOST}:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`Docker 可执行文件: ${DOCKER_BIN}`);
  if (!ACCESS_TOKEN) {
    console.log('提示: 未设置 CYPHER_TOKEN，任何能访问该端口的人都能操作 Docker。');
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !ACCESS_TOKEN) {
    console.warn('警告: 监听非本地地址且未设置访问令牌，请务必配置 CYPHER_TOKEN。');
  }
});
