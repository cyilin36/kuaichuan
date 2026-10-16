/**
 * WS 信令房间：只转发 SDP / ICE 这些协商信息，**不传输文件内容**。
 *
 * 房间按 shareId 划分，一个房间里最多两种角色：sender / receiver。
 */

const MAX_SIGNAL_BYTES = 256 * 1024;

const SENDER_ROLES = new Set(['sender', 'upload']);
const RECEIVER_ROLES = new Set(['receiver', 'download']);
const ALL_ROLES = new Set([...SENDER_ROLES, ...RECEIVER_ROLES]);

export function isValidRole(role) {
  return ALL_ROLES.has(String(role));
}

export function isSenderRole(role) {
  return SENDER_ROLES.has(String(role));
}

export function createSignalingHub({ logger, services }) {
  /** shareId -> Map<ws, { role, since }> */
  const rooms = new Map();

  function roomOf(shareId) {
    let room = rooms.get(shareId);
    if (!room) {
      room = new Map();
      rooms.set(shareId, room);
    }
    return room;
  }

  function peersOf(shareId, except) {
    const room = rooms.get(shareId);
    if (!room) return [];
    return [...room.entries()].filter(([ws]) => ws !== except);
  }

  function rolesOf(shareId) {
    return [...(rooms.get(shareId)?.values() ?? [])].map((entry) => entry.role);
  }

  function send(ws, message) {
    if (ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      logger?.warn('WS 发送失败', { message: err?.message ?? String(err) });
      return false;
    }
  }

  function broadcast(shareId, message, except) {
    let delivered = 0;
    for (const [ws] of peersOf(shareId, except)) {
      if (send(ws, message)) delivered += 1;
    }
    return delivered;
  }

  function join(shareId, ws, role) {
    const room = roomOf(shareId);
    room.set(ws, { role, since: Date.now() });
    services.presence?.join(shareId, role);

    send(ws, { t: 'ready', share: shareId, role, peers: rolesOf(shareId).filter((r) => r !== role) });
    broadcast(shareId, { t: 'peer-joined', role }, ws);
    logger?.debug('WS 加入房间', { share: shareId, role, size: room.size });
    return room.size;
  }

  function leave(shareId, ws) {
    const room = rooms.get(shareId);
    if (!room) return 0;
    const entry = room.get(ws);
    room.delete(ws);
    if (entry) {
      services.presence?.leave(shareId, entry.role);
      broadcast(shareId, { t: 'peer-left', role: entry.role }, ws);
    }
    if (room.size === 0) rooms.delete(shareId);
    return room.size;
  }

  /** 处理一条来自客户端的消息 */
  function handleMessage(shareId, ws, raw) {
    const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8') ?? '';
    if (text.length > MAX_SIGNAL_BYTES) {
      send(ws, { t: 'error', code: 'message_too_large', message: '信令消息过大' });
      return false;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send(ws, { t: 'error', code: 'bad_json', message: '消息不是合法 JSON' });
      return false;
    }

    switch (message?.t) {
      case 'ping':
        send(ws, { t: 'pong' });
        return true;
      case 'signal': {
        const role = rooms.get(shareId)?.get(ws)?.role;
        const delivered = broadcast(shareId, { t: 'signal', from: role, payload: message.payload }, ws);
        if (delivered === 0) send(ws, { t: 'error', code: 'no_peer', message: '对方还没连上' });
        return true;
      }
      case 'bye':
        leave(shareId, ws);
        return true;
      default:
        send(ws, { t: 'error', code: 'unknown_type', message: '不支持的消息类型' });
        return false;
    }
  }

  function closeAll() {
    for (const room of rooms.values()) {
      for (const [ws] of room) {
        try {
          ws.close(1001, 'server closing');
        } catch {
          // 忽略关闭异常
        }
      }
    }
    rooms.clear();
  }

  return {
    join,
    leave,
    handleMessage,
    peersOf,
    rolesOf,
    broadcast,
    closeAll,
    roomCount: () => rooms.size,
  };
}
