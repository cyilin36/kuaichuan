@echo off
rem 原生部署启动脚本（Windows）
rem
rem   deploy\start.bat
rem
rem 首次运行会自动安装依赖、生成 .env，然后启动服务。
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

if not exist node_modules (
  echo [快传] 首次运行，正在安装依赖...
  call scripts\pnpm-local.cmd install
  if errorlevel 1 exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo [快传] 已生成 .env（默认端口 7654，可按需修改）
)

echo [快传] 启动中...按 Ctrl+C 停止
node --env-file-if-exists=.env src\server.js
