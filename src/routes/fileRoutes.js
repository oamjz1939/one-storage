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
  const activeUploads = new Map(); // fileId -> { tmpPath, writeStream, fileStream }
  let isLimitExceeded = false;
  let isAborted = false;

  const cleanupAllActiveUploads = () => {
    for (const [fileId, item] of activeUploads.entries()) {
      try {
        if (item.writeStream && !item.writeStream.destroyed) {
          item.writeStream.destroy();
        }
      } catch {}
      try {
        if (item.fileStream && !item.fileStream.destroyed) {
          item.fileStream.destroy();
        }
      } catch {}
      fsp.unlink(item.tmpPath).catch(() => {});
    }
    activeUploads.clear();
  };

  req.on('aborted', () => {
    isAborted = true;
    cleanupAllActiveUploads();
  });

  req.on('close', () => {
    // 仅当请求数据流未完全接收且响应未结束时，才判定为客户端异常掐断
    if (!req.complete && !res.writableEnded) {
      isAborted = true;
      cleanupAllActiveUploads();
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

    const writeStream = fs.createWriteStream(tmpPath);
    activeUploads.set(fileId, { tmpPath, writeStream, fileStream });
    let bytesWritten = 0;

    fileStream.on('data', (data) => {
      bytesWritten += data.length;
    });

    fileStream.on('limit', () => {
      isLimitExceeded = true;
      try {
        writeStream.destroy();
      } catch {}
      fsp.unlink(tmpPath).catch(() => {});
      activeUploads.delete(fileId);
    });

    const promise = new Promise((resolve, reject) => {
      writeStream.on('finish', async () => {
        if (isAborted) {
          try {
            writeStream.destroy();
          } catch {}
          fsp.unlink(tmpPath).catch(() => {});
          activeUploads.delete(fileId);
          return resolve(); // 客户端已主动掐断，安全解析以防 UnhandledPromiseRejection
        }

        if (isLimitExceeded) {
          try {
            writeStream.destroy();
          } catch {}
          fsp.unlink(tmpPath).catch(() => {});
          activeUploads.delete(fileId);
          return reject(new Error(`文件体积超出限制（最大 ${config.MAX_FILE_SIZE_MB}MB）`));
        }

        const now = Date.now();
        const expiresAt = now + config.FILE_EXPIRE_HOURS * 60 * 60 * 1000;

        try {
          // 数据库记账成功后再重命名为正式物理文件名
          fileDb.create.run({
            id: fileId,
            originalName: filename,
            storedName,
            fileSize: bytesWritten,
            mimeType: mimeType || 'application/octet-stream',
            createdAt: now,
            expiresAt,
          });

          await fsp.rename(tmpPath, finalPath);
          activeUploads.delete(fileId);

          uploadedFiles.push({
            id: fileId,
            originalName: filename,
            fileSize: bytesWritten,
            expiresAt,
          });

          resolve();
        } catch (dbErr) {
          try {
            writeStream.destroy();
          } catch {}
          fsp.unlink(tmpPath).catch(() => {});
          activeUploads.delete(fileId);
          reject(dbErr);
        }
      });

      writeStream.on('error', (err) => {
        try {
          writeStream.destroy();
        } catch {}
        fsp.unlink(tmpPath).catch(() => {});
        activeUploads.delete(fileId);
        reject(err);
      });

      fileStream.on('error', (err) => {
        try {
          writeStream.destroy();
          fileStream.destroy();
        } catch {}
        fsp.unlink(tmpPath).catch(() => {});
        activeUploads.delete(fileId);
        reject(err);
      });
    });

    fileStream.pipe(writeStream);
    filePromises.push(promise);
  });

  bb.on('finish', async () => {
    try {
      await Promise.all(filePromises);

      if (isAborted) {
        cleanupAllActiveUploads();
        return;
      }

      // 广播更新通知
      realtimeHub.broadcastFileListUpdated();

      res.json({
        success: true,
        files: uploadedFiles,
        message: `成功上传 ${uploadedFiles.length} 个文件`,
      });
    } catch (err) {
      cleanupAllActiveUploads();
      if (!res.headersSent) {
        res.status(400).json({ error: err.message || '上传处理失败' });
      }
    }
  });

  bb.on('error', (err) => {
    isAborted = true;
    cleanupAllActiveUploads();
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
  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent && err.code !== 'ECONNABORTED') {
      console.error('[Download] 客户端中断或文件传输异常:', err.message);
    }
  });
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

  // 符合 RFC 6266 与 RFC 5987 标准的编码头：
  // 1. fallback filename 使用安全纯 ASCII 字符，防止旧浏览器解析乱码
  // 2. filename* 按照 RFC 5987 对单引号、括号和星号等保留字符进行严格百分比编码
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const rfc5987Name = encodeURIComponent(filename)
    .replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A');

  const dispositionType = isDangerous ? 'attachment' : 'inline';
  res.setHeader(
    'Content-Disposition',
    `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${rfc5987Name}`
  );
  res.setHeader('Content-Type', isDangerous ? 'application/octet-stream' : (file.mime_type || 'application/octet-stream'));

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

/**
 * 清空全部已存文件
 * DELETE /api/files
 */
router.delete('/', requireAuth, async (req, res) => {
  try {
    const allFiles = fileDb.listAllStoredNames.all();

    // 并行彻底删除磁盘上的所有实体物理文件
    await Promise.all(
      allFiles.map(async (file) => {
        const filePath = path.join(config.UPLOAD_DIR, file.stored_name);
        try {
          await fsp.unlink(filePath);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.error('[DeleteAll] 删除物理文件失败:', file.stored_name, err);
          }
        }
      })
    );

    // 清空数据库中所有文件记录
    fileDb.deleteAll.run();

    // 广播文件列表变动，所有已连接客户端同步清空
    realtimeHub.broadcastFileListUpdated();

    res.json({ success: true, message: '已清空所有文件' });
  } catch (err) {
    console.error('[DeleteAll] 清空所有文件失败:', err);
    res.status(500).json({ error: '清空文件失败' });
  }
});

export default router;
