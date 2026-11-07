import { spawn } from 'node:child_process';

const MAX_OUTPUT = 4 * 1024 * 1024;

export class ExecError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ExecError';
    this.detail = info;
  }
}

/**
 * Run a process without a shell. Arguments are passed as an array, so no
 * user supplied value can ever be interpreted as a shell token.
 */
export function exec(command, args, { cwd, timeout = 120_000, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ExecError(err.message, { command, args }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT) {
        truncated = true;
        return current;
      }
      return current + chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(new ExecError(`命令执行超时（${Math.round(timeout / 1000)}s）`, {
        command, args, stdout, stderr,
      }));
    }, timeout);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    child.on('error', (err) => {
      finish(new ExecError(
        err.code === 'ENOENT' ? `找不到可执行文件: ${command}` : err.message,
        { command, args, stdout, stderr },
      ));
    });

    child.on('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr, truncated };
      if (code === 0) {
        finish(null, result);
        return;
      }
      const message = (stderr || stdout || '').trim()
        || `${command} 退出码 ${code}`;
      finish(new ExecError(message, { command, args, ...result }));
    });
  });
}

export const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';

export function composeArgs(composePath, projectDir, projectName, extra = []) {
  return [
    'compose',
    '--project-name', projectName,
    '--project-directory', projectDir,
    '--file', composePath,
    '--env-file', `${projectDir}/.env`,
    ...extra,
  ];
}

export function docker(args, opts) {
  return exec(DOCKER_BIN, args, opts);
}

/**
 * `docker compose ps --format json` prints either a JSON array (older
 * versions) or one JSON object per line (newer versions).
 */
export function parsePsOutput(raw) {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const candidate = line.trim().replace(/^\[|\]$/g, '');
    if (!candidate) continue;
    try {
      rows.push(JSON.parse(candidate));
    } catch {
      // Ignore stray output that is not JSON (warnings, banners).
    }
  }
  return rows;
}

export function normalizeContainer(row) {
  const publishers = Array.isArray(row.Publishers) ? row.Publishers : [];
  const seen = new Set();
  const links = [];
  for (const p of publishers) {
    const published = Number(p.PublishedPort);
    if (!published) continue;
    const target = Number(p.TargetPort);
    const protocol = p.Protocol || 'tcp';
    const key = `${published}/${target}/${protocol}`;
    // IPv4 and IPv6 bindings are reported separately; keep one per port.
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      published,
      target,
      protocol,
      url: `http://localhost:${published}`,
    });
  }

  return {
    id: row.ID || '',
    name: row.Name || row.Names || '',
    service: row.Service || '',
    image: row.Image || '',
    command: row.Command || '',
    state: (row.State || '').toLowerCase(),
    health: (row.Health || '').toLowerCase(),
    status: row.Status || '',
    exitCode: Number.isFinite(Number(row.ExitCode)) ? Number(row.ExitCode) : null,
    runningFor: row.RunningFor || '',
    ports: row.Ports || '',
    links,
  };
}
