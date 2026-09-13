import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { fileDb, sessionDb } from './db.js';
import { realtimeHub } from './websocket.js';

/**
 * 执行清理任务
 */
export async function runCleanup() {
  const now = Date.now();

  // 1. 清理过期文件
  try {
    const expiredFiles = fileDb.findExpired.all(now);
    let deletedCount = 0;

    for (const file of expiredFiles) {
      const filePath = path.join(config.UPLOAD_DIR, file.stored_name);
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`[Cleanup] 删除过期物理文件失败 ${file.stored_name}:`, err.message);
        }
      }
      fileDb.deleteById.run(file.id);
      deletedCount++;
    }

    if (deletedCount > 0) {
      console.log(`[Cleanup] 已自动清理 ${deletedCount} 个过期文件`);
      realtimeHub.broadcastFileListUpdated();
    }
  } catch (err) {
    console.error('[Cleanup] 扫描过期文件出错:', err);
  }

  // 2. 清理超过 14 天的会话或被注销较久的会话
  try {
    const maxSessionAge = config.SESSION_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
    const sessionExpiredTimestamp = now - maxSessionAge;
    const revokedKeepTimestamp = now - 24 * 60 * 60 * 1000; // 被踢出保留24小时用于记录后彻底清除
    sessionDb.cleanExpired.run(sessionExpiredTimestamp, revokedKeepTimestamp);
  } catch (err) {
    console.error('[Cleanup] 清理过期会话出错:', err);
  }
}

/**
 * 启动定时清理服务 (每 5 分钟执行一次)
 */
export function startCleanupJob(intervalMinutes = 5) {
  // 启动即先执行一次
  runCleanup();
  const intervalMs = intervalMinutes * 60 * 1000;
  return setInterval(runCleanup, intervalMs);
}
