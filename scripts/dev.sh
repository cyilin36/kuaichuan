#!/usr/bin/env sh
# 开发模式启动（--watch + 读取 .env）
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$ROOT/scripts/pnpm-local.sh" dev
