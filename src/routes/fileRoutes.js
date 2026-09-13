import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import busboy from 'busboy';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { fileDb } from '../db.js';
import { realtimeHub } from '../websocket.js';

const router = express.Router();

/**
 * 修复与规范化文件名编码 (解决 multipart Latin-1 解析导致的 UTF-8 中文乱码，并防止二次转码)
 */
export function safeDecodeFilename(rawName) {
  if (!rawName || typeof rawName !== 'string') return '未命名文件';

  // 1. 若已包含 > 255 的正常 Unicode 字符，说明已是正确解码的字符串
  for (let i = 0; i < rawName.length; i++) {
    if (rawName.charCodeAt(i) > 255) {
      return rawName;
    }
  }

  // 2. 检测是否存在 > 127 的 Latin-1 高位字符（多字节 UTF-8 被误当单字节 Latin-1 解析的典型特征）
  const hasHighByte = rawName.split('').some((c) => c.charCodeAt(0) > 127);
  if (!hasHighByte) {
    return rawName;
  }

  // 3. 尝试还原为真正的 UTF-8 字符串
  try {
    const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) {
      return decoded;
    }
  } catch {}

  return rawName;
}

/**
 * 获取文件列表
 * GET /api/files
 */
router.get('/', requireAuth, (req, res) => {
  const now = Date.now();
  const rawFiles = fileDb.listActive.all(now);

  const files = rawFiles.map((f) => ({
    id: f.id,
    originalName: safeDecodeFilename(f.original_name),
    fileSize: f.file_size,
    mimeType: f.mime_type,
    createdAt: f.created_at,
    expiresAt: f.expires_at,
    remainingSeconds: Math.max(0, Math.floor((f.expires_at - now) / 1000)),
  }));

  res.json({ files, serverTime: now });
});

/**
 * 流式大文件上传 (带临时文件隔离与中断清理保护)
 * POST /api/files/upload
 */
router.post('/upload', requireAuth, (req, res) => {
  let bb;
  try {
    bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: config.MAX_FILE_SIZE_BYTES,
        files: 10,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: '无效的多部分请求' });
  }

  const uploadedFiles = [];
  const filePromises = [];
  const activeTempFiles = new Set();
  let isLimitExceeded = false;
  let isAborted = false;

  const cleanupAllActiveTempFiles = () => {
    for (const tmpPath of activeTempFiles) {
      fsp.unlink(tmpPath).catch(() => {});
    }
    activeTempFiles.clear();
  };

  req.on('aborted', () => {
    isAborted = true;
    cleanupAllActiveTempFiles();
  });

  req.on('close', () => {
    // 仅当请求数据流未完全接收且响应未结束时，才判定为客户端异常掐断
    if (!req.complete && !res.writableEnded) {
      isAborted = true;
      cleanupAllActiveTempFiles();
    }
  });

  bb.on('file', (name, fileStream, info) => {
    const rawFilename = info.filename || '未命名文件';
    const mimeType = info.mimeType || 'application/octet-stream';
    const filename = safeDecodeFilename(rawFilename);
    const fileId = crypto.randomUUID();
    const ext = path.extname(filename);
    const storedName = `${fileId}${ext}`;
    const tmpPath = path.join(config.UPLOAD_DIR, `${fileId}.upload.tmp`);
    const finalPath = path.join(config.UPLOAD_DIR, storedName);

    activeTempFiles.add(tmpPath);
    const writeStream = fs.createWriteStream(tmpPath);
    let bytesWritten = 0;

    fileStream.on('data', (data) => {
      bytesWritten += data.length;
    });

    fileStream.on('limit', () => {
      isLimitExceeded = true;
      writeStream.destroy();
      fsp.unlink(tmpPath).catch(() => {});
      activeTempFiles.delete(tmpPath);
    });

    const promise = new Promise((resolve, reject) => {
      writeStream.on('finish', async () => {
        if (isAborted) {
          fsp.unlink(tmpPath).catch(() => {});
          activeTempFiles.delete(tmpPath);
          return reject(new Error('上传已被客户端中止'));
        }

        if (isLimitExceeded) {
          fsp.unlink(tmpPath).catch(() => {});
          activeTempFiles.delete(tmpPath);
          return reject(new Error(`文件体积超出限制（最大 ${config.MAX_FILE_SIZE_MB}MB）`));
        }

        const now = Date.now();
        const expiresAt = now + config.FILE_EXPIRE_HOURS * 60 * 60 * 1000;

        try {
          // 数据库记账成功后再重命名为正式物理文件名
          fileDb.create.run({
            id: fileId,
            originalName: filename || '未命名文件',
            storedName,
            fileSize: bytesWritten,
            mimeType: mimeType || 'application/octet-stream',
            createdAt: now,
            expiresAt,
          });

          await fsp.rename(tmpPath, finalPath);
          activeTempFiles.delete(tmpPath);

          uploadedFiles.push({
            id: fileId,
            originalName: filename,
            fileSize: bytesWritten,
            expiresAt,
          });

          resolve();
        } catch (dbErr) {
          fsp.unlink(tmpPath).catch(() => {});
          activeTempFiles.delete(tmpPath);
          reject(dbErr);
        }
      });

      writeStream.on('error', (err) => {
        fsp.unlink(tmpPath).catch(() => {});
        activeTempFiles.delete(tmpPath);
        reject(err);
      });

      fileStream.on('error', (err) => {
        writeStream.destroy();
        fsp.unlink(tmpPath).catch(() => {});
        activeTempFiles.delete(tmpPath);
        reject(err);
      });
    });

    fileStream.pipe(writeStream);
    filePromises.push(promise);
  });

  bb.on('finish', async () => {
    try {
      await Promise.all(filePromises);

      // 广播更新通知
      realtimeHub.broadcastFileListUpdated();

      res.json({
        success: true,
        files: uploadedFiles,
        message: `成功上传 ${uploadedFiles.length} 个文件`,
      });
    } catch (err) {
      cleanupAllActiveTempFiles();
      if (!res.headersSent) {
        res.status(400).json({ error: err.message || '上传处理失败' });
      }
    }
  });

  bb.on('error', (err) => {
    cleanupAllActiveTempFiles();
    if (!res.headersSent) {
      res.status(500).json({ error: '上传流解析异常' });
    }
  });

  req.pipe(bb);
});

/**
 * 下载文件 (登录会话校验)
 * GET /api/files/:id/download
 */
router.get('/:id/download', requireAuth, (req, res) => {
  const fileId = req.params.id;
  const file = fileDb.findById.get(fileId);

  if (!file) {
    return res.status(404).send('文件不存在或已被删除');
  }

  if (file.expires_at <= Date.now()) {
    return res.status(410).send('文件已过期自动销毁');
  }

  const filePath = path.join(config.UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('物理文件未找到');
  }

  const filename = safeDecodeFilename(file.original_name);
  res.download(filePath, filename);
});

/**
 * 预览 / 在线查看 (防存储型 XSS 安全防护)
 * GET /api/files/:id/raw
 */
router.get('/:id/raw', requireAuth, (req, res) => {
  const fileId = req.params.id;
  const file = fileDb.findById.get(fileId);

  if (!file || file.expires_at <= Date.now()) {
    return res.status(404).send('文件不存在或已过期');
  }

  const filePath = path.join(config.UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('物理文件未找到');
  }

  const filename = safeDecodeFilename(file.original_name);

  // 严格的内容安全防护头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  // 判定是否为潜在恶意可执行脚本文件 (HTML, SVG, XML, JS 等)
  const rawMime = (file.mime_type || '').toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  const dangerousExts = ['.html', '.htm', '.svg', '.xml', '.xhtml', '.js', '.mjs', '.php', '.sh'];
  const isDangerous =
    dangerousExts.includes(ext) ||
    rawMime.includes('html') ||
    rawMime.includes('svg') ||
    rawMime.includes('xml') ||
    rawMime.includes('javascript');

  const encodedName = encodeURIComponent(filename);
  if (isDangerous) {
    // 强制作为附件下载，杜绝同源脚本执行
    res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', 'application/octet-stream');
  } else {
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
  }

  fs.createReadStream(filePath).pipe(res);
});

/**
 * 手动删除文件
 * DELETE /api/files/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const fileId = req.params.id;
  const file = fileDb.findById.get(fileId);

  if (!file) {
    return res.status(404).json({ error: '文件不存在' });
  }

  const filePath = path.join(config.UPLOAD_DIR, file.stored_name);
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[Delete] 删除物理文件失败:', err);
    }
  }

  fileDb.deleteById.run(fileId);

  // 广播文件列表变动
  realtimeHub.broadcastFileListUpdated();

  res.json({ success: true, message: '文件已删除' });
});

export default router;
