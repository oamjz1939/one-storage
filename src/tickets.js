import crypto from 'node:crypto';

/**
 * 内存存储临时下载 Ticket
 * Map<string, { fileId: string, expiresAt: number }>
 */
const ticketStore = new Map();

// 定期清理已过期的 Ticket (每 5 分钟扫描一次)
const ticketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ticket, info] of ticketStore.entries()) {
    if (info.expiresAt <= now) {
      ticketStore.delete(ticket);
    }
  }
}, 5 * 60 * 1000);
ticketCleanupTimer.unref();

/**
 * 为指定文件签发短期只读下载 Ticket
 * @param {string} fileId 文件 ID
 * @param {number} ttlMs 有效期毫秒数 (默认 1 小时)
 * @returns {{ ticket: string, expiresAt: number }}
 */
export function createDownloadTicket(fileId, ttlMs = 60 * 60 * 1000) {
  const ticket = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  ticketStore.set(ticket, { fileId, expiresAt });
  return { ticket, expiresAt };
}

/**
 * 校验 Ticket 是否合法且属于该文件
 * @param {string} ticket 
 * @param {string} fileId 
 * @returns {boolean}
 */
export function verifyDownloadTicket(ticket, fileId) {
  if (!ticket || typeof ticket !== 'string') return false;
  const info = ticketStore.get(ticket);
  if (!info) return false;
  if (info.expiresAt <= Date.now()) {
    ticketStore.delete(ticket);
    return false;
  }
  return info.fileId === fileId;
}
