# 快传

快传是一个可自行部署的文件与文字分享服务。

使用者通过网页选择文件或输入文字，即可生成一条分享链接和一个四位密码。接收方打开链接、输入密码，即可下载文件或查看文字。

## 功能

- **文件分享**：支持多选文件与整个文件夹，接收端保留原有目录结构。
- **文字分享**：接收方可直接复制，或下载为 `.txt` 文件。
- **两种传输方式**：P2P 直传与服务器暂存，详见「传输方式」。
- **密码保护**：四位密码，字符取自大写字母、小写字母与数字，区分大小写。
- **可选限制**：阅后即焚、限制被取走次数、随时作废链接。
- **二维码**：便于手机扫码打开。

## 运行环境

| 项目 | 要求 |
| --- | --- |
| 原生部署 | Node.js 24 或更高版本 |
| 容器部署 | Docker 与 Docker Compose |
| 浏览器 | Chrome、Edge、Firefox、Safari 等现代浏览器 |

## 部署

### 方式一：直接运行

```bash
./scripts/pnpm-local.sh install
cp .env.example .env
pnpm start
```

Windows 系统：

```cmd
scripts\pnpm-local.cmd install
copy .env.example .env
pnpm start
```

服务默认监听 `7654` 端口。在本机访问 <http://localhost:7654>；其他设备访问时，请使用该服务器的可访问地址，例如 `http://<服务器地址>:7654`。若服务位于公网，建议在 `.env` 中将 `BASE_URL` 设置为对应地址。

### 方式二：Docker

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

服务地址与上一种方式相同。数据保存在名为 `kuaichuan-data` 的卷中：执行 `docker compose down` 仅停止服务并保留数据，执行 `docker compose down -v` 会同时删除数据。

如需将数据存放在宿主机目录，请将 `docker-compose.yml` 中的卷映射改为 `./data:/data`，并先执行：

```bash
mkdir -p data && sudo chown 1000:1000 data
```

### 方式三：作为系统服务运行

仓库提供 systemd 服务模板 [deploy/kuaichuan.service](deploy/kuaichuan.service)。请先根据实际路径修改模板中的 `WorkingDirectory` 与 `ExecStart`，再复制到 `/etc/systemd/system/` 并执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kuaichuan
```

## 使用方法

1. 打开首页，选择「文件」或「文字」。
2. 选择传输方式：「P2P 直传」或「暂存到服务器」。
3. 按需设置密码保护、有效期、被取走次数上限与阅后即焚。
4. 点击「生成链接」，将链接或二维码发送给接收方。
5. 接收方打开链接，输入密码后即可下载或查看。

启用密码保护时，四位密码**仅在创建分享时显示一次**，请及时记录。已创建的分享可在 `/manage` 页面查看并作废。

## 传输方式

| 方式 | 说明 |
| --- | --- |
| P2P 直传 | 文件在发送方与接收方浏览器之间直接传输，不写入服务器磁盘。发送方须保持页面打开，页面关闭后链接随即失效。 |
| 暂存 | 文件保存至服务器，默认保留 24 小时，上传完成后发送方可关闭页面。 |

当 P2P 直连无法建立时，系统会自动改用服务器内存转发。该过程同样不写入磁盘，页面会明确提示当前使用的链路。

## 配置

配置文件为项目根目录下的 `.env`，可从 `.env.example` 复制后修改。Docker 部署时，请在 `docker-compose.yml` 的 `environment` 中配置。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_NAME` | `快传` | 页面标题与显示名称 |
| `PORT` | `7654` | 监听端口 |
| `BASE_URL` | 空 | 分享链接使用的地址，例如 `https://share.example.com`；留空则按访问地址自动判断 |
| `DATA_DIR` | `./data` | 数据目录，存放数据库、暂存文件与密钥 |
| `DEFAULT_TTL_HOURS` | `24` | 新建分享的默认保留时长（小时） |
| `MAX_TTL_HOURS` | `168` | 页面可选的最长保留时长（小时） |
| `MAX_FILE_BYTES` | `2147483648` | 单个文件上限（字节），默认 2GB |
| `MAX_TEXT_BYTES` | `1048576` | 单条文字上限（字节），默认 1MB |
| `MAX_TOTAL_BYTES` | `21474836480` | 暂存总量上限（字节），默认 20GB；`0` 表示不限制 |
| `RELAY_ENABLED` | `1` | P2P 无法直连时是否允许使用服务器内存转发；`0` 表示关闭 |
| `STUN_URLS` | 公共 STUN | 打洞使用的 STUN 服务器，逗号分隔；留空表示仅尝试内网直连 |
| `TOKEN_SECRET` | 空 | 令牌签名密钥；留空则首次启动时自动生成并保存至 `data/secret.key` |
| `LOG_LEVEL` | `info` | 日志级别：`debug`、`info`、`warn`、`error` |

完整配置项及逐项说明见 [.env.example](.env.example)。
