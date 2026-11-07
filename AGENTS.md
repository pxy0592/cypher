# Repository Guidelines

## Project Structure & Module Organization

Cypher manages Docker Compose deployments using Node.js 20+ ES modules, without dependencies or a build step.

- `server.js`: HTTP server, authentication, API, and static serving.
- `lib/docker.js`: subprocess execution and Compose helpers.
- `lib/store.js`: application registry, deployment paths, and file persistence.
- `public/`: HTML, browser JavaScript, and CSS assets.
- `data/`: runtime registry, uploads, and default deployment directories.
- `casdoor/` and `smartq/`: local deployment configuration.

## Build, Test, and Development Commands

- `npm start` or `node server.js`: start locally at `http://127.0.0.1:3000`.
- `node --check server.js`: check server syntax; repeat for changed JavaScript files.
- `docker build -t cypher:1.0.0 .`: build the container image.
- `cp .env.example .env`: prepare Compose configuration; set `CYPHER_TOKEN` before running `docker compose up -d --build`.

Requires Docker Engine, Compose, and daemon access. Direct Node startup does not load `.env`.

## Coding Style & Naming Conventions

Use two-space indentation, single-quoted JavaScript strings, semicolons, explicit `.js` import extensions, and `node:` prefixes for built-ins. Use `camelCase` for functions/variables, `PascalCase` for classes, and `UPPER_SNAKE_CASE` for constants. No formatter/linter is configured. Keep subprocess arguments in arrays passed to `spawn`, without shell interpolation.

## Specifications & Agent Responsibilities

Specification directories are absent; establish acceptance criteria before implementation.

- **Spec Architect:** owns `specs/` or `docs/openspec/` and specification tasks; never edits implementation or tests. Include objective, context, business rules, functional/non-functional requirements, acceptance criteria, error cases, and exclusions.
- **Software Engineer:** reads approved specs, creates missing implementation `tasks.md` outside specification directories, and implements only specified behavior with tests. Never edits specs; route behavior changes to the architect.
- **Review Agent:** reports spec compliance, acceptance coverage, gaps, and simplification suggestions; requires corrections before approval.

## Testing Guidelines

No test suite or `npm test` script exists. Add `tests/*.test.js` using `node:test`; run `node --test --experimental-test-coverage`. Cover every acceptance criterion and reach at least 90% unit coverage per implemented unit. Isolate filesystem tests and stub Docker processes. Completion requires passing tests, specification alignment, and review approval.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout. Use concise, imperative commits, optionally prefixed `feat:`, `fix:`, or `docs:`. PRs should link specifications/issues, explain behavior changes, include verification evidence, and provide screenshots for UI changes.

When `.codegraph/` exists, use CodeGraph before searching or reading code. Do not create an index automatically.

## Security & Configuration

Exclude secrets, runtime data, and image archives from commits. Set `CYPHER_TOKEN` before network exposure. Preserve identical host/container data paths and Compose project name `cypher--console`.
