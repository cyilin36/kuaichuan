/**
 * WebRTC 配置：STUN 服务器与传输参数。
 *
 * 不提供 TURN。打洞失败时会自动改用服务器内存转发（不落盘，见 realtime/relay-bridge.js），
 * 对小规模自建场景来说，这比再维护一台 TURN 划算得多。
 *
 * 需要携带某个分享的令牌才能取，避免被匿名白拿。
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

    sendJson(res, 200, {
      iceServers,
      relayEnabled: config.relayEnabled,
      chunkSize: 64 * 1024,
      bufferedAmountLowThreshold: 1024 * 1024,
      maxP2pFileBytes: config.maxP2pFileBytes,
      maxTextBytes: config.maxTextBytes,
    });
  });
}
