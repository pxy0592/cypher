# Cypher · Compose 部署台

[![CI](https://github.com/pxy0592/cypher/actions/workflows/ci.yml/badge.svg)](https://github.com/pxy0592/cypher/actions/workflows/ci.yml)

用浏览器管理 Docker Compose 应用：编写 `.env` 与 compose 文件、导入镜像归档、启动/停止/重启、查看容器状态与日志。

纯 JavaScript 实现，无构建步骤、无第三方运行时依赖（仅 Node 内置模块）。

## 运行

```bash
node server.js
# 打开 http://127.0.0.1:3000
```

要求本机已安装 Docker 与 Compose 插件，且当前用户能访问 Docker 守护进程
（通常需要加入 `docker` 组，或使用 root）。

## 测试

```bash
npm test                                    # 跑 tests/ 下的全部用例
node --test --experimental-test-coverage    # 附带覆盖率
```

用 Node 内置的 `node:test`，不需要安装任何依赖；用例只碰临时目录，
不调用 Docker，所以无需守护进程即可运行。

## 容器化运行

**推荐用仓库里的 `docker-compose.yml`**，它已经处理了同路径挂载、令牌校验和项目名冲突：

```bash
cp .env.example .env
# 编辑 .env，把 CYPHER_TOKEN 换成 openssl rand -hex 32 的输出
docker compose up -d --build
# 打开 http://<宿主机IP>:3000
```

也可以只用环境变量，不建 `.env`：

```bash
export CYPHER_TOKEN=$(openssl rand -hex 32)
export CYPHER_HOME=/srv/cypher      # 宿主机数据目录，可省略（默认同值）
docker compose up -d --build
```

未设置 `CYPHER_TOKEN` 时 `docker compose` 会直接报错退出，不会在无令牌状态下裸奔。
`.env` 已被 `.dockerignore` 排除，不会被打进镜像。

也可以用 `docker run`，但**数据目录必须和容器内路径完全一致**：

```bash
docker build -t cypher:1.0.0 .

docker run -d --name cypher \
  -p 3000:3000 \
  -e CYPHER_TOKEN='换成一个长随机串' \
  -e CYPHER_DATA_DIR=/srv/cypher \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/cypher:/srv/cypher \
  cypher:1.0.0
```

冒号两侧必须相同的原因见下文「compose 里的相对挂载」。

镜像约 393MB（`docker save` 压缩后约 96MB），构建过程不联网、不执行 `apk`：
`docker` 与 `docker-compose` 二进制直接从官方 `docker:27-cli` 镜像复制，
两者均为静态链接，可直接运行在 `node:22-alpine` 上。基础镜像可用构建参数替换：

```bash
docker build --build-arg NODE_IMAGE=node:24-alpine --build-arg DOCKER_CLI_IMAGE=docker:28-cli -t cypher:1.0.0 .
```

### 必须挂载的两样东西

| 挂载 | 作用 | 不挂载的后果 |
| --- | --- | --- |
| `/var/run/docker.sock` | 让容器内的 `docker` 操作宿主机守护进程 | 页面能打开，但所有操作报 `Cannot connect to the Docker daemon` |
| 数据目录（`CYPHER_DATA_DIR`） | 注册表、上传临时文件、默认部署目录 | 容器重启后应用列表与 `.env` 全部丢失 |

容器内 `HOST` 为 `0.0.0.0`、`PORT` 为 `3000`。镜像本身默认 `CYPHER_DATA_DIR=/data`，
`docker-compose.yml` 把它改成 `${CYPHER_HOME:-/srv/cypher}` 以便同路径挂载。
所以 `docker run` 至少要提供 `CYPHER_TOKEN` 和一个真实挂载的数据目录。

### 项目名不能与应用 id 撞名

Cypher 用应用 id 作为 `docker compose --project-name`。如果 Cypher 自身的 compose
项目名与某个应用 id 相同，在那个应用上点「启动」时会重建同名项目，**把 Cypher 自己
的容器替换掉**。实测：Cypher 容器当场退出（退出码 143），页面失联。

示例文件因此用 `cypher--console`（双横线）作为项目名。Cypher 生成应用 id 时会把
连续的非字母数字折叠成单个 `-`（`slugify`），所以任何应用名都**无法**生成双横线的 id。
默认的项目名 `cypher` 则是有风险的：建一个叫 `cypher` 的应用就能撞上。

已验证：改名为 `cypher--console` 后，即使创建了 id 恰为 `cypher-console` 的应用，
两者也能并存（Cypher 自身保持 healthy，应用容器名为 `cypher-console-app-1`）。

### compose 里的相对挂载必须同路径映射数据目录

容器内的 `deployPath` 是**容器路径**，`docker compose` 会把 compose 文件里的相对
bind mount（`./html:/usr/share/nginx/html`）解析成容器内的绝对路径，再把这个绝对
路径发给宿主机守护进程。

实测：数据目录挂成命名卷 `cypher-data:/data` 时，`./html` 会被解析成
`/data/apps/<id>/html`，宿主机上会真的创建一个 root 所有的 `/data/apps/<id>/html`
空目录，容器的 nginx 挂到这个空目录上（不是卷里的内容）。

因此有两种正确做法：

1. **数据目录按相同路径绑定挂载**（推荐，适用于 compose 里有相对挂载的项目）：

   ```bash
   # 宿主机路径与容器内路径完全一致
   -v /srv/cypher:/srv/cypher
   -e CYPHER_DATA_DIR=/srv/cypher
   ```

   这样 `docker compose` 解析出的 `/srv/cypher/apps/<id>/html` 在宿主机上真实存在，
   相对挂载直接生效。自定义部署路径 `/srv/apps/blog` 也需要同样加一条
   `-v /srv/apps/blog:/srv/apps/blog`。

2. **compose 里改用命名卷**（适用于数据目录用命名卷的情况）：
   `myapp_html:/usr/share/nginx/html`，不涉及宿主机路径。

如果应用只用绝对路径的 bind mount，或完全不挂载，则无此约束。

### 以非 root 运行

镜像默认以 root 启动，因为宿主机的 `docker.sock` 通常是 `root:docker` 660。
若宿主机 `docker` 组的 GID 是 973，可以这样降权运行：

```bash
docker run -d --name cypher \
  --user 1000:973 \
  -e CYPHER_TOKEN='...' \
  -e CYPHER_DATA_DIR=/srv/cypher \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/cypher:/srv/cypher \
  cypher:1.0.0
```

用 compose 时把这两行加进 `services.cypher`：

```yaml
    user: "1000:973"        # 973 换成宿主机 getent group docker 的 GID
    group_add: ["973"]      # 部分发行版的 sock 权限靠附加组生效
```

数据目录需要提前 `chown 1000:973 /srv/cypher`，否则容器内无法写注册表。

注意此时 `~/apps/xxx` 会展开成容器内该用户的主目录（uid 1000 对应
`/home/node`），而不是宿主机用户的主目录，因此配置部署路径时建议直接写绝对路径。

### 离线分发

```bash
# 有网机器
docker build -t cypher:1.0.0 .
docker save cypher:1.0.0 | gzip > cypher-1.0.0.tar.gz

# 内网机器
gunzip -c cypher-1.0.0.tar.gz | docker load
docker compose up -d            # 配合仓库里的 docker-compose.yml，无需再构建
```

`docker save` 出来的是完整成品镜像，内网机器**不需要**再准备 `node:22-alpine`
和 `docker:27-cli`。用 compose 时要给 `image` 与 `build` 同时对齐：
`CYPHER_VERSION=1.0.0` 让 `image` 命中已导入的 tag，`docker compose up -d`
会优先使用本地镜像。若想在内网从源码重新构建，才需要预先导入两个基础镜像：

```bash
# 有网机器
docker pull node:22-alpine && docker pull docker:27-cli
docker save node:22-alpine docker:27-cli | gzip > cypher-bases.tar.gz

# 内网机器
gunzip -c cypher-bases.tar.gz | docker load
docker build --network=none -t cypher:1.0.0 .
```

`--network=none` 可以证明构建过程没有联网需求（已验证通过）。

> 若内网机器的 Docker 版本较老，可用 `--build-arg DOCKER_CLI_IMAGE=docker:<对应版本>-cli`
> 调整 CLI 版本，避免客户端与服务端 API 版本不匹配。

### 健康检查

镜像内置 `HEALTHCHECK`，每 30 秒请求一次静态首页（`/` 不需要令牌，不会污染鉴权逻辑）：

```bash
docker inspect --format '{{.State.Health.Status}}' cypher
```

## 配置

通过环境变量调整：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 前请先设置 `CYPHER_TOKEN` |
| `CYPHER_DATA_DIR` | `./data` | 注册表、上传临时目录与默认部署目录的根位置 |
| `CYPHER_TOKEN` | 空 | 设置后所有 `/api` 请求需携带访问令牌 |
| `CYPHER_MAX_UPLOAD_MB` | `4096` | 单个镜像归档的大小上限 |
| `DOCKER_BIN` | `docker` | Docker 可执行文件路径 |

设置令牌后，首次打开页面会提示输入，令牌保存在浏览器 localStorage 中，
并以 `x-cypher-token` 请求头传递。

```bash
CYPHER_TOKEN='换成一个长随机串' HOST=0.0.0.0 node server.js
```

## 功能

- **新建应用** — 每个应用一个独立目录，自动生成 compose 模板与 `.env` 模板
- **指定部署路径** — 创建时可填写宿主机上的任意目录，之后还能迁移；详见下文
- **编辑 compose 文件** — 保存前用 `docker compose config` 校验，失败则回滚并保留原文件
- **编辑 .env** — 每行 `KEY=VALUE`，作为 `--env-file` 传给 compose 做 `${VAR}` 插值
  （只写进 `.env` 不会自动进入容器，compose 里需要 `environment` 显式引用）
- **导入镜像** — 拖拽或选择 `docker save` 生成的 `.tar` / `.tar.gz`，服务端执行 `docker load`
- **启动 / 停止 / 重启 / 移除容器** — 对应 `up -d`、`stop`、`restart`、`down`
- **拉取 / 构建镜像** — 对应 `docker compose pull` / `build`
- **容器状态** — 每 5 秒轮询，展示服务、状态、健康检查、镜像、可点击的端口链接
- **日志** — 查看最近 300 行，按服务过滤
- **删除应用** — 先 `down` 停止并清理容器。默认目录下的文件会一并删除；
  自定义部署路径只从列表中移除，目录内容保留（需输入应用 ID 确认）

## 部署路径

每个应用由一个目录承载，compose 文件与 `.env` 都放在该目录下，`docker compose`
也以它为工作目录执行。目录位置由应用注册表 `data/apps.json` 记录，
**不要求在数据目录内**，可以是宿主机上任意路径。

### 指定方式

在「新建应用」对话框中填写「部署路径」：

| 输入 | 结果 |
| --- | --- |
| 留空 | 使用默认目录 `<CYPHER_DATA_DIR>/apps/<应用id>` |
| `/srv/apps/blog` | 使用该绝对路径，不存在则逐级创建 |
| `~/apps/blog` | `~` 与 `~/` 展开为当前运行 Cypher 的用户主目录 |

只接受绝对路径，相对路径会被拒绝，避免随工作目录漂移。

### 接管已有项目

如果填写的目录里已经有 compose 文件（`docker-compose.yml`、`docker-compose.yaml`、
`compose.yml`、`compose.yaml` 之一），Cypher 不会覆盖它，只补一份缺失的 `.env`
模板并直接登记。因此可以直接把已在运行的 compose 项目纳入管理。

### 迁移

在应用页面的「编辑信息」中修改部署路径即可迁移，流程为：

1. 对旧目录执行 `docker compose down --remove-orphans` 停止并清理容器
   （容器绑定了绝对工作目录，移动前必须先停止）
2. 校验新路径，然后整体移动目录；同一文件系统内用 `rename`，
   跨挂载点自动降级为复制后删除
3. 更新注册表

界面会要求输入 `MOVE` 二次确认。迁移后容器处于停止状态，需要手动点「启动」。

### 校验规则

以下情况会被拒绝，避免误删或覆盖数据：

| 情况 | 结果 |
| --- | --- |
| 相对路径 | 拒绝，提示需绝对路径 |
| 文件系统根目录 `/` | 拒绝 |
| 路径等于数据目录，或是数据目录的上级 | 拒绝 |
| 与已有应用的目录相同、或互为父子目录 | 拒绝（409） |
| 迁移目标已存在且非空 | 拒绝（409） |
| 迁移目标位于当前目录内部 | 拒绝 |
| 目标已存在且不是目录 | 拒绝（409） |

允许把部署路径放在数据目录的子目录下（例如 `<CYPHER_DATA_DIR>/apps/xxx`），
这正是默认行为。这样创建的应用仍记为 `owned: false`，删除时目录会保留。

### 删除时的行为

应用创建时就确定「目录归谁所有」，并记在 `data/apps.json` 的 `owned` 字段里，
删除时直接看这个标记，不再按路径反推：

- **由 Cypher 创建的目录**（`owned: true`，即留空部署路径时的默认目录）：
  连同文件一起删除
- **用户指定的路径**（`owned: false`）：只从 `data/apps.json` 中移除，
  **目录内容原样保留**。即使这个路径恰好位于 `data/apps/` 之下也一样保留。

这个区别写在删除确认框里，接口返回的 `removedFiles` 字段也会标明实际行为。
修改部署路径时 `owned` 会重新判定：迁回默认目录才重新变为 `true`。

升级前写入的旧注册表没有 `owned` 字段，首次启动时按旧规则推断——
只有恰好等于 `<CYPHER_DATA_DIR>/apps/<应用id>` 的路径才算 `owned`。

### 目录被外部改动

应用详情里的「部署路径」一行会实时显示当前路径。如果目录被手动删除或移动，
应用卡片上会出现警示，启动/停止等操作会返回
`部署目录不存在：<路径>`，在「编辑信息」里改到正确位置即可恢复。

## 目录结构

```
server.js              HTTP 服务与 REST API
lib/docker.js          进程调用、compose 参数拼装、ps 输出解析
lib/store.js           应用注册表、部署路径校验与迁移、compose/env 读写
public/index.html      页面骨架
public/app.js          前端逻辑（原生 ES 模块）
public/styles.css      样式
tests/                 node:test 用例（注册表与部署目录，不依赖 Docker）
data/apps.json         应用注册表：id、名称、描述、部署路径
data/uploads/          镜像上传临时目录（上传完成后即删）
data/apps/<id>/        未指定部署路径时的默认承载目录
Dockerfile             容器镜像定义（含 docker CLI 与 compose 插件）
.dockerignore          构建上下文排除项：data/、已部署的应用目录、镜像归档、.env
docker-compose.yml     Cypher 自身的部署示例（项目名 cypher--console，避免与应用 id 撞名）
.env.example           compose 用的环境变量模板，复制为 .env 后填写
.github/workflows/ci.yml  CI：语法检查、compose 校验、离线构建与端到端冒烟
```

部署目录本身只包含 `docker-compose.yml`（或 `compose.yml`）与 `.env`，
Cypher 的元数据全部集中在 `data/apps.json`。升级前若已有旧版数据，
启动时会自动把 `data/apps/<id>/meta.json` 中的记录迁移进注册表，原时间戳保留。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system` | Docker / Compose 版本与守护进程状态 |
| GET | `/api/images` | 本地镜像列表 |
| GET | `/api/apps` | 应用列表 |
| POST | `/api/apps` | 新建应用 `{ name, description, deployPath? }` |
| GET | `/api/apps/:id` | 应用详情 + 容器状态 |
| PATCH | `/api/apps/:id` | 修改名称/描述；传 `deployPath` 则迁移目录 |
| DELETE | `/api/apps/:id` | 停止容器并删除应用 |
| GET/PUT | `/api/apps/:id/files/compose` | 读写 compose 文件 |
| GET/PUT | `/api/apps/:id/files/env` | 读写 `.env` |
| PUT | `/api/apps/:id/images?filename=x.tar` | 上传并 `docker load` 镜像归档 |
| POST | `/api/apps/:id/actions/:action` | `up` / `down` / `stop` / `restart` / `build` / `pull` |
| GET | `/api/apps/:id/logs?tail=300` | 查看日志 |

## 持续集成

`.github/workflows/ci.yml` 在 push 到 `main`、发起 PR 或手动触发时运行，
不需要任何仓库密钥，`permissions` 只要 `contents: read`。

`check` job 做静态检查：对全部受版本控制的 `.js` 跑 `node --check`、
跑 `npm test` 执行单元测试、`docker compose config` 校验示例文件、确认空
`CYPHER_TOKEN` 会被 `${VAR:?}` 拒绝、断言 `public/` 里没有 `http(s)://` 外链
（否则断网部署会白屏）、确认 `data/`、`casdoor/`、`smartq/` 与 `.env` 没有被提交。

`build` job 做端到端验证：先 `docker build --network=none --pull=false`
证明构建过程不联网，再在镜像内检查 `node` / `docker` / `compose` 三件工具，
启动容器并等健康检查变成 `healthy`，然后跑完整生命周期——建应用、写
compose 与 `.env`、`up`、断言容器 `running` 且 `.env` 真的注入到了容器、
看日志、`down`、删除并断言默认部署目录被清理。失败时自动 `docker logs`，
无论成败最后都会移除容器、测试应用与数据卷。

## 安全说明

这个服务能执行 Docker 命令，等价于对宿主机有很高的控制权。默认只监听
`127.0.0.1`，没有内置多用户与权限体系。对外暴露时请至少做到：

- 设置 `CYPHER_TOKEN`
- 在反向代理上加 HTTPS 与额外的身份认证
- 不要把它直接暴露到公网

用户输入不会经过 shell：所有命令用参数数组传给 `spawn`，应用 ID 严格限制为
`[a-z0-9_-]`，静态文件路径做了目录穿越校验。

容器化运行有两处额外注意：

- 挂载 `docker.sock` 等于把宿主机 root 权限交给容器，这是所有同类工具的共同代价。
  请给容器设置 `CYPHER_TOKEN`，并只在内网开放端口。
- 默认以 root 运行（`docker.sock` 权限所致）。多租户场景请用 `--user` 降权，
  并确保 `/data` 与自定义部署目录对该 uid 可写。
