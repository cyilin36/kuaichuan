/**
 * 在线状态：判断某个 P2P 分享的发送方是否还在线。
 *
 * 两个来源：
 *   - WS 房间（浏览器直连信令，P5 接入）
 *   - 内存中继里还有等待接收方接入的会话
 */

export function createPresence({ bridge } = {}) {
  /** shareId -> Set<role> */
  const rooms = new Map();

  function join(shareId, role) {
    let set = rooms.get(shareId);
    if (!set) {
      set = new Set();
      rooms.set(shareId, set);
    }
    set.add(role);
    return set.size;
  }

  function leave(shareId, role) {
    const set = rooms.get(shareId);
    if (!set) return 0;
    set.delete(role);
    if (set.size === 0) rooms.delete(shareId);
    return set.size;
  }

  function leaveAll(socketId) {
    for (const [shareId, set] of rooms) {
      if (set.delete(socketId) && set.size === 0) rooms.delete(shareId);
    }
  }

  function rolesOf(shareId) {
    return [...(rooms.get(shareId) ?? [])];
  }

  /** 发送方是否在线：WS 房间里有 sender，或中继里还挂着等待的上传 */
  function isOnline(shareId) {
    const roles = rooms.get(shareId);
    if (roles && (roles.has('sender') || roles.has('upload'))) return true;
    if (bridge?.hasPendingFor?.(shareId)) return true;
    return false;
  }

  /** 接收方是否在线 */
  function hasReceiver(shareId) {
    const roles = rooms.get(shareId);
    if (roles && (roles.has('receiver') || roles.has('download'))) return true;
    return false;
  }

  return { join, leave, leaveAll, rolesOf, isOnline, hasReceiver, roomCount: () => rooms.size };
}
