/**
 * WebRTC 配置：STUN / TURN 服务器与传输参数。
 *
 * 需要携带某个分享的令牌才能取（避免 TURN 凭据被匿名白拿）。
 */

import { sendJson } from '../respond.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';

export function registerRtcRoutes(router, { config, services }) {
  const { db, tokenSecret } = services;

  router.get('/api/rtc-config', (req, res, { url }) => {
    const shareId = url.searchParams.get('share') ?? '';
    const share = getShareRow(db, shareId);
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    assertShareAvailable(share);

    const iceServers = [];
    if (config.stunUrls.length > 0) iceServers.push({ urls: config.stunUrls });
    if (config.turnUrls.length > 0) {
      const entry = { urls: config.turnUrls };
      if (config.turnUsername) entry.username = config.turnUsername;
      if (config.turnCredential) entry.credential = config.turnCredential;
      iceServers.push(entry);
    }

    sendJson(res, 200, {
      iceServers,
      relayEnabled: config.relayEnabled,
      chunkSize: 64 * 1024,
      bufferedAmountLowThreshold: 1024 * 1024,
      maxFileBytes: config.maxFileBytes,
      maxTextBytes: config.maxTextBytes,
    });
  });
}
