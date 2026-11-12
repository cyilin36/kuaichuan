---
name: kuaichuan
description: 用「快传」服务把文件、文字、日志、截图、报告分享给用户：生成链接 + 4 位密码，用户在任意网络的浏览器打开链接、输入密码即可下载或查看；也能接收用户发来的快传分享链接，下载文件或读取文字。触发词：快传、kuaichuan、分享文件、分享一段文字、把日志/截图/报告发给我、生成分享链接和密码、发个链接给我、接收文件、下载分享、读取分享里的文字。
---

# 快传（kuaichuan）

「快传」是一个自建的文件 / 文字分享服务。用这个 Skill，你可以像用户用网页一样：

- **发送**：把文件、文字、日志、截图、报告分享出去，得到「链接 + 4 位密码」，交给用户在任意网络打开下载或查看。
- **接收**：拿到用户发来的快传链接，下载文件或读取文字。

服务地址：`{{KUAICHUAN_URL}}`（由服务端替换成本地真实地址，不要在命令里写死别的域名）。
CLI 是零依赖 ESM 脚本（Node ≥ 20），只用 `node:` 内置模块与全局 `fetch`，不需要 `npm install`。

## 安装

把 Skill 装进 Agent 的 skills 目录（如 Claude Code 的 `~/.claude/skills/`，其它 Agent 用各自的 skills 目录）：

```bash
SKILL_DIR="${SKILLS_DIR:-$HOME/.claude/skills}/kuaichuan"
mkdir -p "$SKILL_DIR/scripts"
curl -fsSL "{{KUAICHUAN_URL}}/skill.md" -o "$SKILL_DIR/SKILL.md"
curl -fsSL "{{KUAICHUAN_URL}}/skill/scripts/kuaichuan.mjs" -o "$SKILL_DIR/scripts/kuaichuan.mjs"
```

也可以直接复制快传仓库里的 `skills/kuaichuan/` 目录，内容与上面下载的一致。
下文命令里的 `kuaichuan` 指 `node "$SKILL_DIR/scripts/kuaichuan.mjs"`。

## 配置

```bash
kuaichuan setup --url {{KUAICHUAN_URL}}
# 服务端配置了 AGENT_API_KEYS 时需要带上 Key（找服务管理员要）：
kuaichuan setup --url {{KUAICHUAN_URL}} --key <API_KEY>
```

`setup` 会先请求服务端校验地址与 Key，成功才写入配置文件（默认 `$XDG_CONFIG_HOME/kuaichuan/config.json`，未设 XDG 时 `~/.config/kuaichuan/config.json`，权限 0600），并输出 `{ ok, url, configPath, auth }`。

也可以用环境变量（优先级：命令行参数 > 环境变量 > 配置文件）：

| 变量 | 说明 |
|---|---|
| `KUAICHUAN_URL` | 服务地址，如 `{{KUAICHUAN_URL}}` |
| `KUAICHUAN_API_KEY` | 服务端要求的 API Key，可空 |
| `KUAICHUAN_PASSWORD` | `recv` 的默认密码，可选 |
| `KUAICHUAN_STATE_DIR` | 本地状态目录，默认当前目录下 `./.kuaichuan` |
| `KUAICHUAN_CONFIG` | 配置文件路径 |

`send-*` 命令必须能确定服务地址，否则会提示先 `setup`；`recv/status/revoke` 可直接从分享链接里取地址。

## 常用命令

```bash
kuaichuan info                                     # 服务信息、限制、可用端点
kuaichuan send-text "要分享的文字"                  # 默认带 4 位密码、暂存 24 小时
kuaichuan send-text --file ./report.log --title "构建日志" --burn   # 阅后即焚
kuaichuan send-text "内容" --no-password           # 不要密码
kuaichuan send-file ./截图.png ./报告.pdf          # 文件或目录，目录递归展开
kuaichuan send-file ./dist --title "构建产物" --ttl 6
kuaichuan send-text "临时内容" --mode p2p          # P2P 文字，默认后台发送
kuaichuan send-file ./big.iso --mode p2p           # P2P 文件，默认后台发送
kuaichuan recv "https://host/s/Ab12cd" --password aB3x --out ./下载
kuaichuan recv "https://host/s/Ab12cd" --password aB3x --text   # 文字原样打印到 stdout
kuaichuan recv "https://host/s/Ab12cd" --password aB3x --info   # 只看元数据
kuaichuan list                                     # 本机创建过的分享（省略已过期/已撤销）
kuaichuan status "https://host/s/Ab12cd"           # 单个分享状态
kuaichuan revoke "https://host/s/Ab12cd"           # 撤销分享
```

成功时 stdout 只输出一个 JSON；出错时 stderr 输出一行 `{"error":"…","message":"…"}` 且退出码 1；用法错误退出码 2。
`recv --text` 例外：正文原样写到 stdout，不加任何提示。

`send-file` 创建分享前会读取服务端的 `maxFilesPerShare`（默认 500）；文件数超过上限时直接报错，不创建分享，请按目录拆分成多个分享后分批发送。

### 输出字段

- `setup` → `{ ok, url, configPath, auth }`
- `info` → `{ name, version, enabled, auth, docs, skill: { page, script }, limits: { defaultTtlHours, maxTtlHours, maxStagedFileBytes, maxP2pFileBytes, maxTextBytes, maxFilesPerShare, passwordLength }, modes, endpoints }`
- `send-text` / `send-file` → 分享对象：`{ id, kind, mode, title, url, path, expiresAt, ttlHours, password, requiresPassword, ownerToken, maxDownloads, burnAfterRead, totalBytes, files: [{ idx, name, relPath, size, mime, upload }], unlock, relay }`
  - 交给用户的只有 `url` + `password`（`requiresPassword: false` 时不用给密码）。
  - `ownerToken` 是发送方凭据，用来 `revoke`、`status`、`list`，不要发给接收方。
  - `files[].upload` 是暂存上传指引（CLI 会自动上传）；`relay` 是 P2P 中继端点。
  - `--mode p2p` 默认后台发送，额外输出 `{ background: true, pid, log }`。
- `recv`（文件）→ `{ id, title, mode, dir, files: [{ idx, name, path, bytes }] }`；`recv --info` → 分享元数据；`recv --text` → 正文（加 `--json` 则输出含正文的 JSON）。
- `list` → 元数据 JSON 数组（`--all` 保留已过期/已撤销）；`status` → 单个元数据。
- `revoke` → `{ ok, revoked, alreadyRevoked }`。

## P2P（直连）注意事项

- P2P 内容**不经过服务器磁盘**，靠发送端与接收端同时在线通过内存中继配对。链接只在发送端在线期间有效。
- `send-text/send-file --mode p2p` 默认后台执行：父进程立即返回 JSON（含 `pid`、`log`），后台子进程持续重试等待接收方，直到 `--timeout`（默认 1800 秒）。
- **返回后不要立刻结束会话或杀掉该进程**：先告诉用户链接和密码，等对方取走、或用户确认后，再结束（`kill <pid>`）。
- `--foreground` 可前台等待传输完成（会阻塞当前命令）；`status` 可查看传输状态。
- 接收 P2P 分享需要发送端在线，可能等待一段时间；`recv` 默认最多等 600 秒（`--timeout` 可调）。超时说明发送端不在线或已结束。
- 无人接收时服务器会让发送方挂起等待，这是正常现象，不是故障。

## 安全注意事项

- **链接 + 密码就是取件凭据**：只发给指定的接收人，不要贴到公开群聊、公开仓库、公开网页或日志里。
- **不要泄露 API Key**：`KUAICHUAN_API_KEY` 只用于本机配置；不要把 Key、`ownerToken`、密码写进给用户的公开内容或提交到代码仓库。
- 敏感内容用 `--burn`（阅后即焚）或 `--max-downloads 1`（限次），并优先选 `staged` 模式。
- `recv` 会把文件写到 `--out` 指定的目录（默认当前目录下 `./kuaichuan-<id>`）；不要盲目覆盖已有文件，需要时加 `--overwrite`。
- 只接受 `http(s)://` 的服务地址；不要从不可信链接里取服务地址后上传敏感文件。
- 分享内容只在有效期内可取：暂存受 `--ttl`（默认 24 小时）约束；过期、撤销或次数用尽后链接立即失效。
