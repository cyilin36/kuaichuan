/**
 * AI Agent 接口（/api/agent/v1）。
 *
 * 面向 AI Agent 的「一次调用就能拿到可交付结果」的薄层：
 *   - 创建分享时直接返回绝对链接、密码、ownerToken 与后续上传/中继的完整指引
 *   - 读取文字分享时一步完成解锁 + 取件（计次与焚毁语义与网页完全一致）
 *
 * 鉴权：AGENT_API_KEYS 为空时与网页端一致不额外鉴权；配置后要求 Bearer Key。
 * 本文件不保存任何固定 base URL，所有链接按请求的 Origin 现场拼接（与二维码接口一致）。
 */

import { badRequest, conflict } from '../../errors.js';
import { sendJson } from '../respond.js';
import { readJsonBody } from '../limits.js';
import { createAgentAuth } from '../../domain/agent-auth.js';
import { PASSWORD_LENGTH } from '../../domain/passwords.js';
import {
  assertShareAvailable,
  createShare,
  getShareRow,
  MAX_FILES_PER_SHARE,
  unlockShare,
} from '../../domain/shares.js';
import { readStagedText } from '../../domain/text.js';

/** 把请求体收敛成 createShare 认识的入参：AI 默认带密码，网页默认不带 */
function toCreateInput(body) {
  const mode = body.mode === undefined || body.mode === null || body.mode === ''
    ? 'staged'
    : body.mode;
  return {
    kind: body.kind,
    mode,
    title: body.title,
    password: body.password === undefined ? true : body.password === true,
    ttlHours: body.ttlHours,
    maxDownloads: body.maxDownloads,
    burnAfterRead: body.burnAfterRead === true,
    text: body.text,
    files: body.files,
  };
}

function linksFor({ created, origin }) {
  const id = created.id;
  const owner = created.ownerToken;
  return {
    unlock: {
      method: 'POST',
      url: `${origin}/api/shares/${id}/unlock`,
      body: { password: created.password },
    },
    ownerHeaders: { authorization: `Bearer ${owner}` },
    fileUrl: (idx) => `${origin}/api/shares/${id}/files/${idx}`,
    relayTextUrl: `${origin}/api/relay/${id}/text`,
    relayFileUrl: (idx) => `${origin}/api/relay/${id}/f/${idx}`,
  };
}

function buildShareResponse({ created, origin, relayEnabled }) {
  const links = linksFor({ created, origin });
  const files = created.files.map((file) => {
    if (created.mode === 'p2p') {
      return { ...file, upload: null };
    }
    return {
      ...file,
      upload: {
        method: 'PUT',
        url: links.fileUrl(file.idx),
        headers: {
          authorization: `Bearer ${created.ownerToken}`,
          'content-type': 'application/octet-stream',
        },
        offsetHeader: 'Upload-Offset',
        resume: {
          method: 'GET',
          url: `${links.fileUrl(file.idx)}/upload`,
          headers: { authorization: `Bearer ${created.ownerToken}` },
        },
      },
    };
  });

  let relay = null;
  if (created.mode === 'p2p') {
    relay = {
      enabled: relayEnabled,
      sendText: {
        method: 'POST',
        url: links.relayTextUrl,
        headers: {
          authorization: `Bearer ${created.ownerToken}`,
          'content-type': 'text/plain; charset=utf-8',
        },
      },
      sendFile: {
        method: 'POST',
        url: links.relayFileUrl('{idx}'),
        headers: {
          authorization: `Bearer ${created.ownerToken}`,
          'content-type': 'application/octet-stream',
        },
      },
      receiveText: {
        method: 'GET',
        url: links.relayTextUrl,
        headers: { authorization: 'Bearer <解锁后获得的 accessToken>' },
      },
      receiveFile: {
        method: 'GET',
        url: links.relayFileUrl('{idx}'),
        headers: { authorization: 'Bearer <解锁后获得的 accessToken>' },
      },
    };
  }

  return {
    id: created.id,
    kind: created.kind,
    mode: created.mode,
    title: created.title,
    url: `${origin}/s/${created.id}`,
    path: `/s/${created.id}`,
    expiresAt: created.expiresAt,
    ttlHours: created.ttlHours,
    password: created.password,
    requiresPassword: created.requiresPassword,
    ownerToken: created.ownerToken,
    maxDownloads: created.maxDownloads,
    burnAfterRead: created.burnAfterRead,
    totalBytes: created.totalBytes,
    files,
    unlock: links.unlock,
    relay,
  };
}

export function registerAgentRoutes(router, { config, logger, services }) {
  if (!config.agentEnabled) return;

  const { db, locations, tokenSecret } = services;
  const requireAgent = createAgentAuth(config);

  // 能力发现：客户端可用它校验地址与 Key 是否可用
  router.get('/api/agent/v1', async (req, res, { url }) => {
    requireAgent(req);
    const origin = url.origin;
    sendJson(res, 200, {
      name: config.appName,
      version: config.version,
      enabled: true,
      auth: config.agentApiKeys.length > 0 ? 'api-key' : 'none',
      docs: `${origin}/llms.txt`,
      skill: {
        page: `${origin}/skill.md`,
        script: `${origin}/skill/scripts/kuaichuan.mjs`,
      },
      limits: {
        defaultTtlHours: config.defaultTtlHours,
        maxTtlHours: config.maxTtlHours,
        maxStagedFileBytes: config.maxStagedFileBytes,
        maxP2pFileBytes: config.maxP2pFileBytes,
        maxTextBytes: config.maxTextBytes,
        maxFilesPerShare: MAX_FILES_PER_SHARE,
        passwordLength: PASSWORD_LENGTH,
      },
      modes: ['staged', 'p2p'],
      endpoints: {
        createShare: 'POST /api/agent/v1/shares',
        readText: 'POST /api/agent/v1/text/{id}/read',
        unlock: 'POST /api/shares/{id}/unlock',
        uploadFile: 'PUT /api/shares/{id}/files/{idx}',
        uploadStatus: 'GET /api/shares/{id}/files/{idx}/upload',
        stopUpload: 'DELETE /api/shares/{id}/files/{idx}/upload',
        downloadFile: 'GET /api/shares/{id}/files/{idx}',
        archive: 'GET /api/shares/{id}/archive',
        revoke: 'DELETE /api/shares/{id}',
        relayText: 'POST|GET /api/relay/{id}/text',
        relayFile: 'POST|GET /api/relay/{id}/f/{idx}',
      },
    });
  });

  router.post('/api/agent/v1/shares', async (req, res, { url }) => {
    requireAgent(req);
    const body = await readJsonBody(req);
    const created = await createShare({
      db,
      config,
      logger,
      input: toCreateInput(body),
    });
    sendJson(res, 201, buildShareResponse({
      created,
      origin: url.origin,
      relayEnabled: config.relayEnabled,
    }));
  });

  router.post('/api/agent/v1/text/:id/read', async (req, res, { params }) => {
    requireAgent(req);
    const body = await readJsonBody(req);
    const share = getShareRow(db, params.id);
    assertShareAvailable(share);

    if (share.kind !== 'text') throw badRequest('该分享不是文字分享');
    if (share.mode !== 'staged') {
      throw conflict('P2P 文字分享需要发送方在线，请用 Skill 的 recv 命令通过内存中继接收');
    }

    // 无密码分享也走一次解锁，保持与网页端一致的事件记录
    await unlockShare({
      db,
      config,
      tokenSecret,
      share,
      password: typeof body.password === 'string' ? body.password : '',
    });

    const { text, burned } = await readStagedText({ db, locations, logger, share });
    const downloads = share.downloads + 1;

    sendJson(res, 200, {
      id: share.id,
      title: share.title,
      text,
      totalBytes: share.totalBytes,
      downloads,
      maxDownloads: share.maxDownloads,
      downloadsLeft: share.maxDownloads === null
        ? null
        : Math.max(0, share.maxDownloads - downloads),
      burned,
      expiresAt: share.expiresAt,
    });
  });
}
