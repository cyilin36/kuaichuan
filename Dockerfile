# 快传（kuaichuan）—— 生产镜像
#
# 特点：无原生模块、无构建步骤，镜像里只有 Node + 两个纯 JS 依赖。

FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7654 \
    DATA_DIR=/data \
    ALLOW_EXTERNAL_DATA_DIR=1 \
    TMPDIR=/data/tmp

WORKDIR /app

# 依赖与缓存都留在项目内（pnpm-workspace.yaml 已把 storeDir/cacheDir 指到项目目录）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/pnpm-local.sh ./scripts/pnpm-local.sh

RUN corepack enable \
 && corepack prepare pnpm@11.22.0 --activate \
 && sh ./scripts/pnpm-local.sh install --prod --frozen-lockfile \
 && rm -rf .pnpm-store .cache

COPY src ./src
COPY public ./public
COPY scripts/docker-entrypoint.mjs ./scripts/docker-entrypoint.mjs

# 数据目录在镜像里先建好并归 node：命名卷首次挂载会沿用这个属主。
# bind mount 时宿主机目录可能属于 root 或宿主机上的其他用户，
# 由入口脚本在启动时纠正（见 scripts/docker-entrypoint.mjs）。
RUN mkdir -p /data/files /data/logs /data/tmp && chown -R node:node /data /app

VOLUME ["/data"]
EXPOSE 7654

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:7654/healthz > /dev/null || exit 1

# 入口脚本以 root 启动，先把数据目录属主纠正为 node（uid 1000），
# 再降权到 node 启动真正的服务进程。宿主机因此不需要任何 sudo chown。
ENTRYPOINT ["node", "scripts/docker-entrypoint.mjs"]
CMD ["node", "src/server.js"]
