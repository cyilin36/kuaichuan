@echo off
rem 用 pnpm 时统一走这个包装脚本（Windows）。
rem store/cache 在 pnpm-workspace.yaml 里已固定到项目内，这里补上机器级的 stateDir。
setlocal

set "ROOT=%~dp0.."
if not defined npm_config_state_dir set "npm_config_state_dir=%ROOT%\.cache\pnpm-state"
if not defined pnpm_config_state_dir set "pnpm_config_state_dir=%ROOT%\.cache\pnpm-state"
if not defined npm_config_cache set "npm_config_cache=%ROOT%\.cache\npm"
if not defined XDG_STATE_HOME set "XDG_STATE_HOME=%ROOT%\.cache\state"

cd /d "%ROOT%"
call pnpm %*
