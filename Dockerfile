# 不使用 # syntax 指令：那需要 BuildKit 拉取 frontend 镜像，
# 在干净的内网机器上会直接失败。这里只用经典语法。
ARG NODE_IMAGE=node:22-alpine
ARG DOCKER_CLI_IMAGE=docker:27-cli

# 官方 docker CLI 镜像：提供静态链接的 docker 与 docker-compose 插件
FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="Cypher" \
      org.opencontainers.image.description="Web console for deploying Docker Compose applications"

# 二进制从官方镜像复制，构建过程不联网、不执行 apk。
# 两者都是静态链接的 musl 程序，可直接运行在 alpine 上。
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose \
     /usr/local/libexec/docker/cli-plugins/docker-compose

RUN ln -sf /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose \
 && mkdir -p /app /data \
 && chown -R node:node /data

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CYPHER_DATA_DIR=/data

# 无第三方依赖，直接拷贝源码；data/ 等目录已被 .dockerignore 排除
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 默认以 root 运行，因为 /var/run/docker.sock 通常是 root:docker 660。
# 需要非 root 时见 README 的 --user / --group-add 用法。
EXPOSE 3000

# 静态首页是公开的，作为存活探针不触发认证
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

CMD ["node", "server.js"]
