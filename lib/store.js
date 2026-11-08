import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const COMPOSE_CANDIDATES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

const DEFAULT_COMPOSE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "\${APP_PORT:-8080}:80"
    environment:
      TZ: \${TZ:-Asia/Shanghai}
`;

const DEFAULT_ENV = `# 每行一个 KEY=VALUE，作为 --env-file 供 compose 做 \${VAR} 插值。
# 想让变量进入容器，compose 里要写 environment: { KEY: "\${KEY}" }
APP_PORT=8080
TZ=Asia/Shanghai
`;

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(id);
}

export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// Windows and macOS resolve paths case-insensitively, so a plain string compare
// would let `/srv/apps` and `/srv/Apps` count as two unrelated directories and
// slip past the overlap checks below.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function fold(target) {
  return CASE_INSENSITIVE_FS ? target.toLowerCase() : target;
}

function samePath(a, b) {
  return fold(a) === fold(b);
}

function isInside(child, parent) {
  const inner = fold(child);
  const outer = fold(parent);
  return inner === outer || inner.startsWith(outer + path.sep);
}

async function isEmptyDir(target) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return false;
    return (await fs.readdir(target)).length === 0;
  } catch {
    return false;
  }
}

/**
 * Apps are recorded in a single registry file instead of one folder per app,
 * so the deployment directory (where compose/.env live) can be anywhere on
 * the host while Cypher's own metadata stays under the data directory.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.defaultRoot = path.join(dataDir, 'apps');
    this.registryPath = path.join(dataDir, 'apps.json');
    this.tmpDir = path.join(dataDir, 'uploads');
    this.entries = new Map();
  }

  async init() {
    await fs.mkdir(this.defaultRoot, { recursive: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.registryPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : [];
      for (const entry of list) {
        if (entry && isValidId(entry.id) && entry.deployPath) {
          const deployPath = path.resolve(String(entry.deployPath));
          this.entries.set(entry.id, {
            id: entry.id,
            name: entry.name || entry.id,
            description: entry.description || '',
            deployPath,
            // Registries written before `owned` existed are judged by the old
            // rule: only the canonical default directory counts as ours.
            owned: typeof entry.owned === 'boolean'
              ? entry.owned
              : samePath(deployPath, this.defaultDirFor(entry.id)),
            createdAt: entry.createdAt || null,
            updatedAt: entry.updatedAt || null,
          });
        }
      }
    } catch {
      await this.adoptLegacyApps();
    }
  }

  /** Earlier versions kept a meta.json inside data/apps/<id>; import those. */
  async adoptLegacyApps() {
    let dirs = [];
    try {
      dirs = await fs.readdir(this.defaultRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !isValidId(dir.name)) continue;
      const appPath = path.join(this.defaultRoot, dir.name);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(appPath, 'meta.json'), 'utf8'));
        this.entries.set(dir.name, {
          id: dir.name,
          name: meta.name || dir.name,
          description: meta.description || '',
          deployPath: appPath,
          owned: true,
          createdAt: meta.createdAt || null,
          updatedAt: meta.updatedAt || null,
        });
      } catch {
        // Not an app directory.
      }
    }
    await this.persist();
  }

  async persist() {
    const list = [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    // Write-then-rename: a crash or a concurrent writer must never leave a
    // truncated registry behind, because losing it loses every application.
    const tmp = `${this.registryPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list, null, 2));
    await fs.rename(tmp, this.registryPath);
  }

  /** Turn user input into an absolute path; `~/` expands to the home dir. */
  normalizePath(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new StoreError('部署路径不能为空');
    if (raw.length > 512) throw new StoreError('部署路径过长');
    let expanded = raw;
    if (raw === '~') expanded = os.homedir();
    else if (raw.startsWith('~/')) expanded = path.join(os.homedir(), raw.slice(2));
    if (!path.isAbsolute(expanded)) {
      throw new StoreError('部署路径必须是绝对路径，例如 /srv/apps/my-app 或 ~/apps/my-app');
    }
    const resolved = path.resolve(expanded);
    if (resolved === path.parse(resolved).root) {
      throw new StoreError('不能使用文件系统根目录作为部署路径');
    }
    const dataRoot = path.resolve(this.dataDir);
    if (isInside(dataRoot, resolved)) {
      // The data directory itself, or any of its parents, would be clobbered.
      throw new StoreError('部署路径不能包含数据目录');
    }
    return resolved;
  }

  /** Reject paths that collide with, or nest inside, another app. */
  assertNoOverlap(resolved, selfId) {
    for (const entry of this.entries.values()) {
      if (entry.id === selfId) continue;
      const other = path.resolve(entry.deployPath);
      if (isInside(resolved, other) || isInside(other, resolved)) {
        throw new StoreError(`部署路径与已有应用「${entry.name}」重叠：${other}`, 409);
      }
    }
  }

  /** The directory Cypher itself creates when no deployPath is supplied. */
  defaultDirFor(id) {
    return path.join(this.defaultRoot, id);
  }

  tmpPath() {
    return path.join(this.tmpDir, `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.tar`);
  }

  async list() {
    // Each read() hits the filesystem a few times; run them together so the
    // sidebar does not wait on apps one at a time.
    const apps = await Promise.all([...this.entries.keys()].map((id) => this.read(id)));
    return apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async read(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new StoreError('应用不存在', 404);
    const deployPath = entry.deployPath;
    const missing = !(await exists(deployPath));
    return {
      id,
      name: entry.name,
      description: entry.description,
      deployPath,
      owned: entry.owned,
      missing,
      composeFile: missing ? null : await this.detectComposeFile(deployPath),
      hasEnv: missing ? false : await exists(path.join(deployPath, '.env')),
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    };
  }

  async detectComposeFile(dir) {
    for (const name of COMPOSE_CANDIDATES) {
      if (await exists(path.join(dir, name))) return name;
    }
    return null;
  }

  async create({ name, description = '', deployPath }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new StoreError('应用名称不能为空');
    if (cleanName.length > 64) throw new StoreError('应用名称过长（最多 64 字符）');

    let base = slugify(cleanName);
    if (!base) {
      base = `app-${crypto.randomBytes(3).toString('hex')}`;
    } else if (!/^[a-z]/.test(base)) {
      base = `app-${base}`;
    }

    let id = base;
    let counter = 2;
    while (this.entries.has(id)) {
      id = `${base}-${counter++}`;
      if (counter > 999) throw new StoreError('无法生成唯一应用 ID', 409);
    }

    const custom = String(deployPath ?? '').trim() !== '';
    let dir;
    // `owned` is decided once, when the directory is claimed, and then stored.
    // Deriving it from the path at delete time let a user-supplied path that
    // happened to sit under data/apps/ be wiped along with the app.
    let owned;
    if (custom) {
      dir = this.normalizePath(deployPath);
      this.assertNoOverlap(dir, null);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        throw new StoreError(`无法创建部署目录：${err.message}`, 400);
      }
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) throw new StoreError('部署路径不是目录', 400);
      owned = false;
    } else {
      dir = this.defaultDirFor(id);
      await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
      owned = true;
    }

    // Never overwrite an existing compose file in a user supplied directory:
    // pointing at an already deployed project should just register it.
    if (!(await this.detectComposeFile(dir))) {
      await fs.writeFile(path.join(dir, 'docker-compose.yml'), DEFAULT_COMPOSE);
    }
    if (!(await exists(path.join(dir, '.env')))) {
      await fs.writeFile(path.join(dir, '.env'), DEFAULT_ENV);
    }

    const now = new Date().toISOString();
    this.entries.set(id, {
      id, name: cleanName, description, deployPath: dir, owned, createdAt: now, updatedAt: now,
    });
    await this.persist();
    return this.read(id);
  }

  async updateMeta(id, patch) {
    const entry = this.entries.get(id);
    if (!entry) throw new StoreError('应用不存在', 404);

    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new StoreError('应用名称不能为空');
      if (name.length > 64) throw new StoreError('应用名称过长（最多 64 字符）');
      entry.name = name;
    }
    if (patch.description !== undefined) {
      entry.description = String(patch.description).slice(0, 500);
    }
    if (patch.deployPath !== undefined && String(patch.deployPath).trim() !== '') {
      const target = this.normalizePath(patch.deployPath);
      if (!samePath(target, path.resolve(entry.deployPath))) {
        await this.moveDeployDir(entry, target);
        entry.deployPath = target;
        // Re-anchor ownership on the new location: only the canonical default
        // directory is disposable, a user-chosen one never is.
        entry.owned = samePath(target, this.defaultDirFor(entry.id));
      }
    }
    entry.updatedAt = new Date().toISOString();
    await this.persist();
    return this.read(id);
  }

  /** Move the deployment directory, refusing targets that would lose data. */
  async moveDeployDir(entry, target) {
    const source = path.resolve(entry.deployPath);
    this.assertNoOverlap(target, entry.id);
    if (isInside(target, source)) {
      throw new StoreError('新路径不能位于当前部署路径内部');
    }
    if (isInside(source, target)) {
      throw new StoreError('新路径不能包含当前部署路径');
    }

    if (await exists(target)) {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) throw new StoreError('目标路径已存在且不是目录', 409);
      const items = await fs.readdir(target);
      if (items.length) throw new StoreError('目标目录已存在且不为空', 409);
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
    }

    if (!(await exists(source))) {
      await fs.mkdir(target, { recursive: true });
      return;
    }
    try {
      await fs.rename(source, target);
    } catch (err) {
      // Linux lets rename replace an existing empty directory; Windows rejects
      // it with EPERM/EEXIST. Fall back to copy-then-delete only when the
      // target is the empty directory validated above, so real failures stay
      // visible instead of being swallowed.
      if (err.code !== 'EXDEV' && !(await isEmptyDir(target))) {
        throw new StoreError(`迁移部署目录失败：${err.message}`, 500);
      }
      await fs.cp(source, target, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
    }
  }

  async remove(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new StoreError('应用不存在', 404);
    const dir = path.resolve(entry.deployPath);
    // Only clean up directories Cypher itself created. A user supplied
    // deployment path may hold files we know nothing about. This uses the
    // stored flag rather than re-deriving it from the path, so a custom path
    // that happens to live under data/apps/ survives deletion.
    const owned = entry.owned === true;
    this.entries.delete(id);
    await this.persist();
    if (owned) await fs.rm(dir, { recursive: true, force: true });
    return { removedFiles: owned, deployPath: dir };
  }

  async readFile(id, fileName) {
    const app = await this.read(id);
    try {
      return await fs.readFile(path.join(app.deployPath, fileName), 'utf8');
    } catch {
      return null;
    }
  }

  async writeFile(id, fileName, content) {
    const app = await this.read(id);
    const dir = app.deployPath;
    if (app.missing) throw new StoreError(`部署目录不存在：${dir}`, 409);
    if (typeof content !== 'string') throw new StoreError('文件内容必须是文本');
    if (content.length > 1024 * 1024) throw new StoreError('文件内容过大（上限 1MB）');
    // Validate compose syntax before persisting so a broken file never
    // replaces a working one.
    if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
      const target = path.join(dir, fileName);
      const backup = `${target}.bak`;
      if (await exists(target)) await fs.copyFile(target, backup);
      await fs.writeFile(target, content);
      try {
        const { docker, composeArgs } = await import('./docker.js');
        await docker(composeArgs(target, dir, id, ['config', '--quiet']), { cwd: dir });
      } catch (err) {
        if (await exists(backup)) await fs.rename(backup, target);
        else await fs.rm(target, { force: true });
        throw new StoreError(`Compose 文件校验失败：${err.message}`, 422);
      }
      await fs.rm(backup, { force: true });
    } else {
      await fs.writeFile(path.join(dir, fileName), content);
    }
    const entry = this.entries.get(id);
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      await this.persist();
    }
  }
}
