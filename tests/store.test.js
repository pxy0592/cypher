import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store.js';

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cypher-store-'));
  const store = new Store(path.join(root, 'data'));
  await store.init();
  return { root, store, dataDir: path.join(root, 'data') };
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('默认目录创建的应用标记为 owned，删除时清理文件', async () => {
  const { root, store } = await makeStore();
  try {
    const app = await store.create({ name: 'default app' });
    assert.equal(app.owned, true);
    assert.equal(app.deployPath, store.defaultDirFor(app.id));

    const result = await store.remove(app.id);
    assert.equal(result.removedFiles, true);
    await assert.rejects(fs.access(app.deployPath));
  } finally {
    await cleanup(root);
  }
});

test('自定义路径创建的应用不标记 owned，删除时保留文件', async () => {
  const { root, store } = await makeStore();
  try {
    const target = path.join(root, 'deploy');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'notes.txt'), 'keep\n');

    const app = await store.create({ name: 'custom app', deployPath: target });
    assert.equal(app.owned, false);

    const result = await store.remove(app.id);
    assert.equal(result.removedFiles, false);
    assert.equal(await fs.readFile(path.join(target, 'notes.txt'), 'utf8'), 'keep\n');
  } finally {
    await cleanup(root);
  }
});

test('自定义路径即使位于 data/apps 下也不会被删除', async () => {
  const { root, store } = await makeStore();
  try {
    const target = path.join(store.defaultRoot, 'my-own');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'important.txt'), 'keep me\n');

    const app = await store.create({ name: 'under apps', deployPath: target });
    assert.equal(app.owned, false);

    const result = await store.remove(app.id);
    assert.equal(result.removedFiles, false);
    assert.equal(await fs.readFile(path.join(target, 'important.txt'), 'utf8'), 'keep me\n');
  } finally {
    await cleanup(root);
  }
});

test('owned 写入注册表并在重新加载后保留', async () => {
  const { root, store, dataDir } = await makeStore();
  try {
    const customTarget = path.join(root, 'deploy');
    const custom = await store.create({ name: 'custom', deployPath: customTarget });
    const plain = await store.create({ name: 'plain' });

    const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf8'));
    assert.equal(raw.find((e) => e.id === custom.id).owned, false);
    assert.equal(raw.find((e) => e.id === plain.id).owned, true);

    const reloaded = new Store(dataDir);
    await reloaded.init();
    assert.equal((await reloaded.read(custom.id)).owned, false);
    assert.equal((await reloaded.read(plain.id)).owned, true);
  } finally {
    await cleanup(root);
  }
});

test('旧注册表缺少 owned 时按默认目录推断', async () => {
  const { root, store, dataDir } = await makeStore();
  try {
    const plain = await store.create({ name: 'plain' });
    const stale = {
      // A legacy entry pointing at a directory under data/apps that is NOT the
      // default dir for its id. The old path-based rule would have deleted it.
      id: 'legacy-custom',
      name: 'legacy custom',
      deployPath: path.join(store.defaultRoot, 'held-by-user'),
      createdAt: null,
      updatedAt: null,
    };
    const legacyDefault = {
      id: plain.id,
      name: plain.name,
      deployPath: plain.deployPath,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
    await fs.writeFile(
      path.join(dataDir, 'apps.json'),
      JSON.stringify([stale, legacyDefault]),
    );

    const reloaded = new Store(dataDir);
    await reloaded.init();
    assert.equal((await reloaded.read('legacy-custom')).owned, false);
    assert.equal((await reloaded.read(plain.id)).owned, true);
  } finally {
    await cleanup(root);
  }
});

test('迁移到默认目录后变为 owned，迁出后变回 false', async () => {
  const { root, store } = await makeStore();
  try {
    const app = await store.create({ name: 'mover' });
    assert.equal(app.owned, true);

    const outside = path.join(root, 'elsewhere');
    await store.updateMeta(app.id, { deployPath: outside });
    assert.equal((await store.read(app.id)).owned, false);
    assert.equal((await store.read(app.id)).deployPath, outside);

    await store.updateMeta(app.id, { deployPath: store.defaultDirFor(app.id) });
    const back = await store.read(app.id);
    assert.equal(back.owned, true);
    assert.equal(back.deployPath, store.defaultDirFor(app.id));
  } finally {
    await cleanup(root);
  }
});

test('接管已有项目不覆盖 compose，且不被视为 owned', async () => {
  const { root, store } = await makeStore();
  try {
    const target = path.join(root, 'existing');
    await fs.mkdir(target, { recursive: true });
    const compose = 'services:\n  web:\n    image: nginx:alpine\n';
    await fs.writeFile(path.join(target, 'docker-compose.yml'), compose);

    const app = await store.create({ name: 'existing', deployPath: target });
    assert.equal(app.owned, false);
    assert.equal(app.composeFile, 'docker-compose.yml');
    assert.equal(await fs.readFile(path.join(target, 'docker-compose.yml'), 'utf8'), compose);

    await store.remove(app.id);
    assert.equal(await fs.readFile(path.join(target, 'docker-compose.yml'), 'utf8'), compose);
  } finally {
    await cleanup(root);
  }
});

test('部署路径校验拒绝相对路径、根目录与包含数据目录的路径', async () => {
  const { root, store } = await makeStore();
  try {
    await assert.rejects(
      store.create({ name: 'rel', deployPath: 'relative/dir' }),
      (err) => err.status === 400 && /绝对路径/.test(err.message),
    );
    await assert.rejects(
      store.create({ name: 'root', deployPath: '/' }),
      (err) => err.status === 400 && /根目录/.test(err.message),
    );
    await assert.rejects(
      store.create({ name: 'clobber', deployPath: root }),
      (err) => err.status === 400 && /数据目录/.test(err.message),
    );
  } finally {
    await cleanup(root);
  }
});

test('部署路径与已有应用重叠时拒绝', async () => {
  const { root, store } = await makeStore();
  try {
    const first = await store.create({ name: 'first' });
    await assert.rejects(
      store.create({ name: 'nested', deployPath: path.join(first.deployPath, 'sub') }),
      (err) => err.status === 409 && /重叠/.test(err.message),
    );
    await assert.rejects(
      store.create({ name: 'parent', deployPath: path.dirname(first.deployPath) }),
      (err) => err.status === 409 && /重叠/.test(err.message),
    );
  } finally {
    await cleanup(root);
  }
});

test('应用 id 重复时追加序号，中文名回退为 app-<hash>', async () => {
  const { root, store } = await makeStore();
  try {
    const a = await store.create({ name: 'blog' });
    const b = await store.create({ name: 'blog' });
    assert.equal(a.id, 'blog');
    assert.equal(b.id, 'blog-2');

    const zh = await store.create({ name: '博客' });
    assert.match(zh.id, /^app-[0-9a-f]{6}$/);
    assert.equal(zh.owned, true);
  } finally {
    await cleanup(root);
  }
});

test('名称校验与列表排序', async () => {
  const { root, store } = await makeStore();
  try {
    await assert.rejects(store.create({ name: '   ' }), (err) => err.status === 400);
    await assert.rejects(store.create({ name: 'x'.repeat(65) }), (err) => err.status === 400);

    await store.create({ name: 'beta' });
    await store.create({ name: 'alpha' });
    const names = (await store.list()).map((app) => app.name);
    assert.deepEqual(names, ['alpha', 'beta']);
  } finally {
    await cleanup(root);
  }
});

test('迁移拒绝非空目标与互相嵌套的路径', async () => {
  const { root, store } = await makeStore();
  try {
    const app = await store.create({ name: 'mover' });

    const busy = path.join(root, 'busy');
    await fs.mkdir(busy, { recursive: true });
    await fs.writeFile(path.join(busy, 'x'), 'x');
    await assert.rejects(
      store.updateMeta(app.id, { deployPath: busy }),
      (err) => err.status === 409 && /不为空/.test(err.message),
    );

    await assert.rejects(
      store.updateMeta(app.id, { deployPath: path.join(app.deployPath, 'inner') }),
      (err) => /内部/.test(err.message),
    );
    await assert.rejects(
      store.updateMeta(app.id, { deployPath: root }),
      (err) => err.status === 400,
    );
  } finally {
    await cleanup(root);
  }
});

test('迁移到已存在空目录可用，源目录缺失时只建目标目录', async () => {
  const { root, store } = await makeStore();
  try {
    const app = await store.create({ name: 'mover' });
    const empty = path.join(root, 'empty');
    await fs.mkdir(empty, { recursive: true });
    await store.updateMeta(app.id, { deployPath: empty });
    assert.equal((await store.read(app.id)).owned, false);

    await fs.rm(empty, { recursive: true, force: true });
    const revived = path.join(root, 'revived');
    await store.updateMeta(app.id, { deployPath: revived });
    assert.equal((await store.read(app.id)).missing, false);
  } finally {
    await cleanup(root);
  }
});

test('部署目录被删除后标记 missing，写入 .env 可用', async () => {
  const { root, store } = await makeStore();
  try {
    const app = await store.create({ name: 'writer' });
    await store.writeFile(app.id, '.env', 'A=1\n');
    assert.equal(await store.readFile(app.id, '.env'), 'A=1\n');
    assert.equal(await store.readFile(app.id, 'missing.txt'), null);

    await fs.rm(app.deployPath, { recursive: true, force: true });
    assert.equal((await store.read(app.id)).missing, true);
    await assert.rejects(
      store.writeFile(app.id, '.env', 'A=2\n'),
      (err) => err.status === 409 && /部署目录不存在/.test(err.message),
    );

    assert.equal((await store.remove(app.id)).removedFiles, true);
  } finally {
    await cleanup(root);
  }
});

test('读取不存在的应用返回 404', async () => {
  const { root, store } = await makeStore();
  try {
    await assert.rejects(store.read('nope'), (err) => err.status === 404);
    await assert.rejects(store.remove('nope'), (err) => err.status === 404);
    await assert.rejects(store.updateMeta('nope', { name: 'x' }), (err) => err.status === 404);
  } finally {
    await cleanup(root);
  }
});

test('旧版 meta.json 目录会被接管为 owned', async () => {
  const { root, store } = await makeStore();
  try {
    const legacyDir = path.join(store.defaultRoot, 'legacy-app');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'meta.json'),
      JSON.stringify({ name: '旧应用', description: 'old', createdAt: '2020-01-01T00:00:00.000Z' }),
    );
    await fs.mkdir(path.join(store.defaultRoot, 'not-an-app'), { recursive: true });

    // Legacy adoption only runs when no registry exists yet. Plain `init()`
    // always writes one, so drop it to model an upgrade from the old layout.
    await fs.rm(store.registryPath, { force: true });

    const reloaded = new Store(store.dataDir);
    await reloaded.init();
    const app = await reloaded.read('legacy-app');
    assert.equal(app.name, '旧应用');
    assert.equal(app.owned, true);
    await assert.rejects(reloaded.read('not-an-app'), (err) => err.status === 404);
  } finally {
    await cleanup(root);
  }
});
