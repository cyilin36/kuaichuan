#!/usr/bin/env sh
# 用 pnpm 时统一走这个包装脚本。
#
# store 与 cache 已在 pnpm-workspace.yaml 里固定到项目内；
# stateDir 是机器级设置（pnpm 不读项目配置），所以在这里用环境变量注入。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

export npm_config_state_dir="${npm_config_state_dir:-$ROOT/.cache/pnpm-state}"
export pnpm_config_state_dir="${pnpm_config_state_dir:-$ROOT/.cache/pnpm-state}"
export npm_config_cache="${npm_config_cache:-$ROOT/.cache/npm}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$ROOT/.cache/state}"

cd "$ROOT"
exec pnpm "$@"
