# 快传

自建的文件与文字分享服务。在网页上选择文件或输入文字，生成一条链接和四位密码；对方打开链接、输入密码，即可下载或查看。

## 功能

- 支持多选文件和整个文件夹，接收端保留原有目录结构。
- 支持文字分享，可直接复制或下载为 `.txt`。
- 直接传输：文件在两台设备之间直接传递，不保存到服务器，发送方需保持页面打开。
- 先上传到服务器：文件保存到服务器，默认保留 24 小时，上传完成后发送方可关闭页面。
- 传输过程中可以暂停、继续或停止；先上传到服务器时支持断点续传。
- 可设置密码、被取走次数、阅后即焚，支持二维码。

## 运行

需要 Node.js 24 或 Docker。

使用 Docker：

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

数据保存在 `kuaichuan-data` 卷中。

直接运行：

```bash
./scripts/pnpm-local.sh install
cp .env.example .env
pnpm start
```

数据保存在 `data/` 目录中。

启动后访问 <http://localhost:7654>。其他设备请使用服务器可访问的地址打开。更新 Docker 镜像时执行 `docker compose pull && docker compose up -d`。

## 使用

1. 选择「文件」或「文字」，再选择传输方式。
2. 按需设置密码、被取走次数、阅后即焚；选择「先上传到服务器」时还可设置有效期。
3. 点击「生成链接」，把链接或二维码发给对方。
4. 对方打开链接、输入密码，即可下载或查看。
5. 传输过程中可以使用「暂停」「继续」「停止」。

启用密码保护时，密码只在创建分享时显示一次，请及时记录。已创建的分享可在 `/manage` 页面查看和作废。

## 配置

端口、有效期、容量等配置见 [.env.example](.env.example)。原生部署修改 `.env`，Docker 部署修改 `docker-compose.yml` 中的 `environment`。
