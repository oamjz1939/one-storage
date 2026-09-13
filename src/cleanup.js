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

  // 3. 磁盘反向扫描：清理孤儿文件与未完成上传的残留临时文件
  try {
    const diskFiles = await fs.readdir(config.UPLOAD_DIR);
    const knownRows = fileDb.listAllStoredNames.all();
    const knownStoredNames = new Set(knownRows.map((r) => r.stored_name));
    let orphanCount = 0;

    for (const filename of diskFiles) {
      const filePath = path.join(config.UPLOAD_DIR, filename);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      const fileAgeMs = now - stat.mtimeMs;

      // 超过 15 分钟未完成的临时文件，判定为中断上传残留
      if (filename.endsWith('.upload.tmp')) {
        if (fileAgeMs > 15 * 60 * 1000) {
          await fs.unlink(filePath).catch(() => {});
          orphanCount++;
        }
        continue;
      }

      // 磁盘上有但数据库无记录，且创建超过 15 分钟的孤儿文件
      if (!knownStoredNames.has(filename) && fileAgeMs > 15 * 60 * 1000) {
        await fs.unlink(filePath).catch(() => {});
        orphanCount++;
      }
    }

    if (orphanCount > 0) {
      console.log(`[Cleanup] 已自动清理 ${orphanCount} 个磁盘孤儿/残留临时文件`);
    }
  } catch (err) {
    console.error('[Cleanup] 扫描孤儿文件出错:', err);
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

/**
 * 停止定时清理服务
 */
export function stopCleanupJob(timer) {
  if (timer) {
    clearInterval(timer);
  }
}
