/**
 * AI 接入的说明文档与 Skill 分发端点。
 *
 *   GET /llms.txt                     给 AI Agent 看的接入指南（动态注入当前地址）
 *   GET /skill.md                     Skill 说明页（仓库 skills/kuaichuan/SKILL.md 模板渲染）
 *   GET /skill/scripts/kuaichuan.mjs  Skill 的零依赖 CLI 本体
 *
 * 只读取仓库内固定路径的文件，不接收任何用户输入拼路径；
 * 文档端点不需要 API Key，方便「安装时选地址」。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { internal } from '../../errors.js';
import { MAX_FILES_PER_SHARE } from '../../domain/shares.js';
import { ROOT } from '../../paths.js';
import { sendText } from '../respond.js';

const SKILL_DIR = path.join(ROOT, 'skills', 'kuaichuan');
const SKILL_PAGE = path.join(SKILL_DIR, 'SKILL.md');
const SKILL_SCRIPT = path.join(SKILL_DIR, 'scripts', 'kuaichuan.mjs');

const STAFF_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'",
};

function agentAuthLine(config) {
  return config.agentApiKeys.length > 0
    ? '所有 /api/agent/v1 请求都必须带 `Authorization: Bearer <API Key>`（Key 找部署者要）。'
    : '当前部署未启用 API Key，/api/agent/v1 可直接调用（与网页端一致）。';
}

function curlAuth(config) {
  return config.agentApiKeys.length > 0
    ? ' \\\n  -H "Authorization: Bearer $KUAICHUAN_API_KEY"'
    : '';
}

/** 供 AI Agent 直接阅读的纯文本接入指南 */
export function renderLlmsTxt({ config, origin }) {
  const auth = agentAuthLine(config);
  const header = curlAuth(config);
  return `# 快传（kuaichuan）AI Agent 接入指南

快传是自建的文件 / 文字分享服务：创建分享会得到「链接 + 4 位密码」，接收方打开
链接、输入密码即可下载文件或查看文字。支持两种模式：

- staged：文件暂存到服务器，默认保留 ${config.defaultTtlHours} 小时，链接随时可用（推荐 AI 使用）
- p2p：文件不落服务器，经内存中继直传，发送方必须在线（用 Skill CLI 处理）

本服务地址（Origin）：${origin}
接口能力发现：GET ${origin}/api/agent/v1
${auth}

## 一、给 AI 装 Skill（推荐，安装最方便）

Skill 说明页：${origin}/skill.md
Skill 脚本：${origin}/skill/scripts/kuaichuan.mjs

安装：把说明页保存为 <skills>/kuaichuan/SKILL.md，把脚本保存为
<skills>/kuaichuan/scripts/kuaichuan.mjs，然后配置服务地址：

    node <skills>/kuaichuan/scripts/kuaichuan.mjs setup --url ${origin}${config.agentApiKeys.length > 0 ? ' --key <API Key>' : ''}

之后可直接用：

    kuaichuan.mjs send-text "要分享的文字"
    kuaichuan.mjs send-file ./report.pdf ./logs/
    kuaichuan.mjs recv "${origin}/s/xxxxxx" --password abcd --out ./downloads
    kuaichuan.mjs list
    kuaichuan.mjs revoke "${origin}/s/xxxxxx"

## 二、直接调用 HTTP API

### 1. 分享文字（staged，一步完成）
    curl -sS -X POST ${origin}/api/agent/v1/shares${header} \\
      -H 'content-type: application/json' \\
      -d '{"kind":"text","text":"hello"}'

返回 JSON 里的 url 与 password 交给接收方；ownerToken 用于撤销。
接收方取文字（会计次 / 触发阅后即焚）：

    curl -sS -X POST ${origin}/api/agent/v1/text/<id>/read${header} \\
      -H 'content-type: application/json' -d '{"password":"<password>"}'

### 2. 分享文件（staged）
先创建分享（文件大小必须如实填写）：

    curl -sS -X POST ${origin}/api/agent/v1/shares${header} \\
      -H 'content-type: application/json' \\
      -d '{"kind":"file","files":[{"name":"a.txt","size":5}]}'

响应 files[i].upload 给了每个文件的 PUT 地址与请求头（含 ownerToken），逐个上传：

    curl -sS -X PUT "${origin}/api/shares/<id>/files/0" \\
      -H "Authorization: Bearer <ownerToken>" \\
      -H 'content-type: application/octet-stream' \\
      --data-binary @a.txt

上传全部完成后，链接与密码即可交给接收方。

### 3. 接收别人发来的文件（staged）
    curl -sS -X POST ${origin}/api/shares/<id>/unlock \\
      -H 'content-type: application/json' -d '{"password":"<password>"}'

拿 accessToken，再查元数据与下载：

    curl -sS "${origin}/api/shares/<id>?t=<accessToken>"
    curl -sS -o a.txt "${origin}/api/shares/<id>/files/0?t=<accessToken>"
    curl -sS -o all.zip "${origin}/api/shares/<id>/archive?t=<accessToken>"

下载支持 Range 与 ETag；暂存文件可以直接续传。

### 4. P2P（不落服务器）
创建时传 "mode":"p2p"。发送方（ownerToken）与接收方（accessToken）通过内存中继
配对，两个请求会互相等待；发送方必须在接收方在线期间保持进程：

    发送：POST ${origin}/api/relay/<id>/f/<idx>   （ownerToken，body 为文件字节）
    接收：GET  ${origin}/api/relay/<id>/f/<idx>   （accessToken）

文字用 ${origin}/api/relay/<id>/text（POST 发、GET 收）。中继等待超时默认
${config.relayWaitSeconds} 秒，超时后重试即可。P2P 不适合「先发链接、很久以后再取」的场景。

### 5. 撤销
    curl -sS -X DELETE "${origin}/api/shares/<id>" -H "Authorization: Bearer <ownerToken>"

## 三、限制

- 单文件上限：暂存 ${config.maxStagedFileBytes === 0 ? '不限' : `MAX_FILE_BYTES=${config.maxStagedFileBytes} 字节`}；P2P ${config.maxP2pFileBytes === 0 ? '不限' : `${config.maxP2pFileBytes} 字节`}
- 文字上限：${config.maxTextBytes === 0 ? '不限' : `${config.maxTextBytes} 字节`}
- 单个分享最多 ${MAX_FILES_PER_SHARE} 个文件
- staged 有效期：默认 ${config.defaultTtlHours} 小时，最长 ${config.maxTtlHours} 小时
- 密码为 4 位字母数字，只在创建分享时返回一次，无法找回
- P2P 文字/文件不落盘；staged 内容在到期或撤销后删除

## 四、安全

- 链接 + 密码就是取件凭据，不要发到公开渠道；敏感内容可设置 maxDownloads=1 或 burnAfterRead=true
- 不要在任何日志、提交、公开页面里输出 API Key
- 接口不开启 CORS，只给服务端 / CLI 调用
`;
}

async function renderSkillPage(origin) {
  const template = await fsp.readFile(SKILL_PAGE, 'utf8');
  return template.split('{{KUAICHUAN_URL}}').join(origin);
}

async function readSkillScript() {
  return fsp.readFile(SKILL_SCRIPT, 'utf8');
}

export function registerAgentDocsRoutes(router, { config, logger }) {
  if (!config.agentEnabled) return;

  router.get('/llms.txt', (req, res, { url }) => {
    sendText(res, 200, renderLlmsTxt({ config, origin: url.origin }), {
      headers: STAFF_HEADERS,
    });
  });

  router.get('/skill.md', async (req, res, { url }) => {
    let content;
    try {
      content = await renderSkillPage(url.origin);
    } catch (err) {
      logger?.error('读取 Skill 文档失败', { message: err?.message ?? String(err) });
      throw internal('Skill 文档尚未就绪');
    }
    sendText(res, 200, content, {
      contentType: 'text/markdown; charset=utf-8',
      headers: STAFF_HEADERS,
    });
  });

  router.get('/skill/scripts/kuaichuan.mjs', async (req, res) => {
    let content;
    try {
      content = await readSkillScript();
    } catch (err) {
      logger?.error('读取 Skill 脚本失败', { message: err?.message ?? String(err) });
      throw internal('Skill 脚本尚未就绪');
    }
    sendText(res, 200, content, {
      contentType: 'text/javascript; charset=utf-8',
      headers: STAFF_HEADERS,
    });
  });
}

export { SKILL_DIR, SKILL_PAGE, SKILL_SCRIPT };
