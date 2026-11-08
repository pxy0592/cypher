# Repository Guidelines

## Project Structure & Module Organization

Cypher manages Docker Compose deployments using Node.js 20+ ES modules, without dependencies or a build step.

- `server.js`: HTTP server, authentication, API, and static serving. Everything
  runs through `createServer(options)`, which takes the store, the Docker
  runner, the token and the static root as options; the entry point at the
  bottom only listens when the file is executed directly.
- `lib/docker.js`: subprocess execution and Compose helpers.
- `lib/store.js`: application registry, deployment paths, and file persistence.
- `public/`: HTML, browser JavaScript, and CSS assets.
- `data/`: runtime registry, uploads, and default deployment directories.
- `casdoor/` and `smartq/`: local deployment configuration. Both are gitignored,
  so a fresh checkout does not contain them; do not create them just to match
  this list.

## Build, Test, and Development Commands

- `npm start` or `node server.js`: start locally at `http://127.0.0.1:3000`.
- `node --check server.js`: check server syntax; repeat for changed JavaScript files.
- `docker build -t cypher:1.0.0 .`: build the container image.
- `cp .env.example .env`: prepare Compose configuration; set `CYPHER_TOKEN` before running `docker compose up -d --build`.

Requires Docker Engine, Compose, and daemon access. Direct Node startup does not load `.env`.

CI keeps three behaviours pinned; a change that breaks one of them fails the run
rather than degrading silently: a malformed `Host` header must not crash the
server, static assets must come back gzip-encoded with a reusable `ETag`, and
`public/` must not reference external origins.

## Coding Style & Naming Conventions

Use two-space indentation, single-quoted JavaScript strings, semicolons, explicit `.js` import extensions, and `node:` prefixes for built-ins. Use `camelCase` for functions/variables, `PascalCase` for classes, and `UPPER_SNAKE_CASE` for constants. No formatter/linter is configured. Keep subprocess arguments in arrays passed to `spawn`, without shell interpolation.

## Specifications & Agent Responsibilities

Specification directories are absent; establish acceptance criteria before implementation.

- **Spec Architect:** owns `specs/` or `docs/openspec/` and specification tasks; never edits implementation or tests. Include objective, context, business rules, functional/non-functional requirements, acceptance criteria, error cases, and exclusions.
- **Software Engineer:** reads approved specs, creates missing implementation `tasks.md` outside specification directories, and implements only specified behavior with tests. Never edits specs; route behavior changes to the architect.
- **Review Agent:** reports spec compliance, acceptance coverage, gaps, and simplification suggestions; requires corrections before approval.

## Testing Guidelines

`npm test` runs `node --test tests/*.test.js`. There are two suites:
`tests/store.test.js` covers the registry, deployment-path validation, migration
and `owned` semantics; `tests/server.test.js` boots `createServer()` on an
ephemeral port and drives the real routes — auth, static delivery, the app
lifecycle, compose validation and error mapping — against a temporary data
directory and a stub `exec`. Add new cases as `tests/*.test.js` using
`node:test`; keep filesystem work inside temporary directories and never call
Docker.

Prefer booting `createServer()` over spawning `server.js` in a child process:
that factory exists so routes can be exercised in-process.

- `npm test` — the whole suite.
- `node tests/server.test.js` — run one file in-process.
- `node --test --experimental-test-coverage` — with coverage.

`node --test` spawns each test file as a child process with piped stdio, which
fails with `spawn EPERM` inside sandboxes that block piped child output. Running
the file directly (as above) avoids that and is the fallback there.

Cover every acceptance criterion and reach at least 90% unit coverage per
implemented unit. Completion requires passing tests, specification alignment,
and review approval.

## Commit & Pull Request Guidelines

Git history is available; read it before changing behaviour. Use concise,
imperative commits, optionally prefixed `feat:`, `fix:`, or `docs:`. PRs should
link specifications/issues, explain behavior changes, include verification
evidence, and provide screenshots for UI changes.

When `.codegraph/` exists, use CodeGraph before searching or reading code. Do not create an index automatically.

## Security & Configuration

Exclude secrets, runtime data, and image archives from commits. Set `CYPHER_TOKEN` before network exposure. Preserve identical host/container data paths and Compose project name `cypher--console`.

The token travels in request headers only — `Authorization: Bearer …` or
`x-cypher-token`. Never accept it from a cookie: browsers attach cookies to
cross-site requests, so a cookie-based token turns every mutating route into a
CSRF target. The web UI keeps the token in `localStorage` and sends the header.

Every response carries a CSP, so `public/` must not gain inline `<script>`,
`eval`, or references to external origins. Inline `style` attributes are the one
allowed exception.
