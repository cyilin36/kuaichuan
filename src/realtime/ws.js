/**
 * WebSocket 接入层：鉴权、Origin 校验、心跳，然后把消息交给信令 hub。
 *
 * 浏览器无法在 WS 上自定义请求头，所以令牌走查询参数 `?t=`（日志已统一剥离 query）。
 */

import { WebSocketServer } from 'ws';

import { getShare } from '../storage/shares.repo.js';
import { assertShareAvailable, resolveViewer } from '../domain/shares.js';
import { assertShareId } from '../paths.js';
import { createSignalingHub, isSenderRole, isValidRole } from './signaling.js';

const HEARTBEAT_MS = 30_000;

export function attachWebSocket({ server, config, logger, services }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const hub = createSignalingHub({ logger, services });

  function isAllowedOrigin(origin, req) {
    if (!origin) return true; // 非浏览器客户端（脚本/测试）不会带 Origin
    try {
      const originHost = new URL(origin).host;
      if (originHost === req.headers.host) return true;
      if (config.baseUrl && new URL(config.baseUrl).host === originHost) return true;
      return false;
    } catch {
      return false;
    }
  }

  function deny(socket, status, reason) {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      // 忽略写入失败
    }
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      deny(socket, 400, 'BadRequest');
      return;
    }

    if (url.pathname !== '/ws') {
      deny(socket, 404, 'NotFound');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, req)) {
      deny(socket, 403, 'Forbidden');
      return;
    }

    const shareId = url.searchParams.get('share') ?? '';
    const role = url.searchParams.get('role') ?? 'receiver';
    const token = url.searchParams.get('t') ?? '';

    if (!/^[A-Za-z0-9]{4,32}$/.test(shareId) || !isValidRole(role)) {
      deny(socket, 400, 'BadRequest');
      return;
    }

    let share;
    try {
      assertShareId(shareId);
      share = getShare(services.db, shareId);
    } catch {
      deny(socket, 400, 'BadRequest');
      return;
    }
    if (!share) {
      deny(socket, 404, 'NotFound');
      return;
    }

    const viewer = resolveViewer({ tokenSecret: services.tokenSecret, share, token });
    if (!viewer) {
      deny(socket, 401, 'Unauthorized');
      return;
    }
    // 发送方必须是创建者；接收方需要解锁后的访问令牌
    if (isSenderRole(role) ? viewer.role !== 'owner' : false) {
      deny(socket, 403, 'Forbidden');
      return;
    }

    try {
      assertShareAvailable(share);
    } catch {
      deny(socket, 410, 'Gone');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.shareId = shareId;
      ws.role = String(role);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    hub.join(ws.shareId, ws, ws.role);
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => hub.handleMessage(ws.shareId, ws, raw));
    ws.on('close', () => hub.leave(ws.shareId, ws));
    ws.on('error', (err) => logger?.warn('WS 连接异常', { message: err?.message ?? String(err) }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // 忽略
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    wss,
    hub,
    close: () => {
      clearInterval(heartbeat);
      hub.closeAll();
      wss.close();
    },
  };
}
