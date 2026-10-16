#!/usr/bin/env sh
# 原生部署启动脚本（Linux / macOS）
#
#   sh deploy/start.sh
#
# 首次运行会自动安装依赖、生成 .env，然后启动服务。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ ! -d node_modules ]; then
  echo "[快传] 首次运行，正在安装依赖…"
  sh ./scripts/pnpm-local.sh install
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[快传] 已生成 .env（默认端口 7654，可按需修改）"
fi

echo "[快传] 启动中…按 Ctrl+C 停止"
exec node --env-file-if-exists=.env src/server.js
