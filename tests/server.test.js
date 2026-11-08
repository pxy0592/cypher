import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createServer } from '../server.js';
import { ExecError } from '../lib/docker.js';

const TOKEN = 'test-token';
const quiet = { log() {}, warn() {}, error() {} };

let server;
let root;
let port;
let calls;
// Flipped by the compose-validation test so the stub rejects `compose config`.
let configFails = false;

function ok(stdout = '') {
  return { code: 0, stdout, stderr: '' };
}

/**
 * Stands in for the Docker CLI: records every argument array and answers the
 * handful of shapes the server parses. No daemon, no binary.
 */
async function fakeExec(args, opts = {}) {
  calls.push({ args, cwd: opts.cwd });
  if (configFails && args.includes('--quiet')) {
    throw new ExecError('services.app.ports must be a list', { code: 1, stdout: '', stderr: '' });
  }
  if (args[0] === 'version') return ok('27.3.1\n');
  if (args[0] === 'compose' && args[1] === 'version') return ok('2.29.1\n');
  if (args.includes('ps')) {
    return ok(JSON.stringify([{
      ID: 'deadbeefcafe0000',
      Name: 'demo-app-1',
      Service: 'app',
      State: 'running',
      Health: 'healthy',
      Image: 'nginx:alpine',
      Publishers: [{ PublishedPort: 8080, TargetPort: 80, Protocol: 'tcp' }],
    }]));
  }
  if (args.includes('--services')) return ok('app\n');
  return ok('');
}

function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const auth = { 'x-cypher-token': TOKEN };

function jsonRequest(method, pathname, payload) {
  return request(method, pathname, {
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const parse = (response) => JSON.parse(response.body.toString('utf8'));

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cypher-server-'));
  calls = [];
  server = createServer({ dataDir: path.join(root, 'data'), token: TOKEN, exec: fakeExec, logger: quiet });
  await server.ready;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- auth */

test('缺少令牌时 API 返回 401', async () => {
  const res = await request('GET', '/api/system');
  assert.equal(res.status, 401);
  assert.equal(parse(res).error, '需要访问令牌');
});

test('令牌可以走 x-cypher-token 请求头', async () => {
  const res = await request('GET', '/api/system', { headers: auth });
  assert.equal(res.status, 200);
  const body = parse(res);
  assert.equal(body.daemon, true);
  assert.equal(body.dockerVersion, '27.3.1');
  assert.equal(body.composeVersion, '2.29.1');
});

test('令牌也可以走 Authorization: Bearer', async () => {
  const res = await request('GET', '/api/system', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
});

test('cookie 不作为凭据，避免跨站请求携带', async () => {
  const res = await request('GET', '/api/system', { headers: { cookie: `cypher_token=${TOKEN}` } });
  assert.equal(res.status, 401);
});

test('OPTIONS 预检不需要令牌', async () => {
  const res = await request('OPTIONS', '/api/apps');
  assert.equal(res.status, 204);
});

/* ------------------------------------------------------- static delivery */

test('每个响应都带安全响应头', async () => {
  for (const res of [await request('GET', '/'), await request('GET', '/api/system')]) {
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  }
});

test('静态资源带 ETag，命中后返回 304', async () => {
  const first = await request('GET', '/app.js');
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, '应返回 ETag');

  const second = await request('GET', '/app.js', { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
});

test('静态资源按需 gzip，解压后与原文一致', async () => {
  const compressed = await request('GET', '/app.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');

  const original = await fs.readFile(new URL('../public/app.js', import.meta.url));
  assert.equal(original.length > compressed.body.length, true, 'gzip 应当更小');
  assert.equal(zlib.gunzipSync(compressed.body).length, original.length);

  const plain = await request('GET', '/app.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(Number(plain.headers['content-length']), original.length);
});

test('目录穿越与未知路径返回 404', async () => {
  for (const target of ['/..%2f..%2fserver.js', '/%2e%2e/server.js', '/nope.js']) {
    const res = await request('GET', target);
    assert.equal(res.status, 404, target);
  }
});

test('畸形百分号是 400，不是 500', async () => {
  const res = await request('GET', '/api/apps/demo/files/%', { headers: auth });
  assert.equal(res.status, 400);
  assert.equal(parse(res).error, '文件类型无法解析');
});

test('畸形 Host 头不会打崩服务', async () => {
  const res = await request('GET', '/api/system', { headers: { host: 'a<b' } });
  assert.ok(res.status >= 400 && res.status < 500, `期望 4xx，实际 ${res.status}`);
  const alive = await request('GET', '/');
  assert.equal(alive.status, 200);
});

/* ---------------------------------------------------------- app lifecycle */

test('应用生命周期：创建、读取、写文件、启动、日志、删除', async () => {
  const created = await jsonRequest('POST', '/api/apps', { name: 'demo' });
  assert.equal(created.status, 201);
  const { app } = parse(created);
  assert.equal(app.id, 'demo');
  assert.equal(app.owned, true);

  const list = parse(await request('GET', '/api/apps', { headers: auth }));
  assert.equal(list.apps.length, 1);

  const detail = parse(await request('GET', '/api/apps/demo', { headers: auth }));
  assert.equal(detail.app.id, 'demo');
  assert.equal(detail.containers.length, 1);
  assert.equal(detail.containers[0].state, 'running');
  assert.equal(detail.containers[0].links[0].url, 'http://localhost:8080');

  const saved = await jsonRequest('PUT', '/api/apps/demo/files/compose', {
    content: 'services:\n  app:\n    image: nginx:alpine\n',
  });
  assert.equal(saved.status, 200);

  const env = await jsonRequest('PUT', '/api/apps/demo/files/env', { content: 'APP_PORT=8080\n' });
  assert.equal(env.status, 200);

  const read = parse(await request('GET', '/api/apps/demo/files/env', { headers: auth }));
  assert.equal(read.content, 'APP_PORT=8080\n');

  const up = await jsonRequest('POST', '/api/apps/demo/actions/up', {});
  assert.equal(up.status, 200);
  const upBody = parse(up);
  assert.equal(upBody.action, 'up');
  assert.equal(upBody.containers[0].state, 'running');

  const logs = parse(await request('GET', '/api/apps/demo/logs?tail=10', { headers: auth }));
  assert.equal(typeof logs.logs, 'string');

  const removed = await request('DELETE', '/api/apps/demo', { headers: auth });
  assert.equal(removed.status, 200);
  assert.equal(parse(removed).removedFiles, true);

  const gone = await request('GET', '/api/apps/demo', { headers: auth });
  assert.equal(gone.status, 404);
});

test('compose 校验失败时回滚并返回 422', async () => {
  const created = await jsonRequest('POST', '/api/apps', { name: 'broken' });
  assert.equal(created.status, 201);

  const before = parse(await request('GET', '/api/apps/broken/files/compose', { headers: auth })).content;

  configFails = true;
  try {
    const res = await jsonRequest('PUT', '/api/apps/broken/files/compose', {
      content: 'services: [this is not valid\n',
    });
    assert.equal(res.status, 422);
    assert.match(parse(res).error, /校验失败/);
  } finally {
    configFails = false;
  }

  const afterContent = parse(await request('GET', '/api/apps/broken/files/compose', { headers: auth })).content;
  assert.equal(afterContent, before, '校验失败必须保留原文件');
});

test('非法应用 ID 与未知路由分别返回 400 / 404', async () => {
  assert.equal((await request('GET', '/api/apps/ABC', { headers: auth })).status, 400);
  assert.equal((await request('GET', '/api/apps/..%2f..%2fetc', { headers: auth })).status, 400);
  assert.equal((await request('GET', '/api/nope', { headers: auth })).status, 404);
});

test('compose 调用带上了项目名、项目目录与 env-file', async () => {
  const created = await jsonRequest('POST', '/api/apps', { name: 'args' });
  assert.equal(created.status, 201);
  await jsonRequest('PUT', '/api/apps/args/files/compose', {
    content: 'services:\n  app:\n    image: nginx:alpine\n',
  });
  calls.length = 0;
  await jsonRequest('POST', '/api/apps/args/actions/up', {});

  const invoked = calls.find((entry) => entry.args.includes('up'));
  assert.ok(invoked, '应调用 compose up');
  assert.equal(invoked.args[0], 'compose');
  assert.equal(invoked.args[invoked.args.indexOf('--project-name') + 1], 'args');
  assert.match(invoked.args[invoked.args.indexOf('--env-file') + 1], /[\\/]\.env$/);
  assert.ok(invoked.cwd.endsWith(path.join('apps', 'args')), 'cwd 应为部署目录');
});
