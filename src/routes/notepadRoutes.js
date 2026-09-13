import express from 'express';
import { requireAuth } from '../auth.js';
import { notepadDb } from '../db.js';
import { realtimeHub } from '../websocket.js';

const router = express.Router();

/**
 * 获取当前草稿纸内容
 */
router.get('/', requireAuth, (req, res) => {
  const row = notepadDb.get.get();
  res.json({
    content: row ? row.content : '',
    updatedAt: row ? row.updated_at : Date.now(),
  });
});

/**
 * 更新草稿纸内容 (HTTP 接口备用/提交)
 */
router.post('/', requireAuth, (req, res) => {
  const { content } = req.body || {};
  const text = typeof content === 'string' ? content : '';
  const now = Date.now();

  notepadDb.save.run({ content: text, updatedAt: now });

  // 广播给所有客户端
  realtimeHub.broadcast({
    type: 'NOTEPAD_SYNC',
    content: text,
    updatedAt: now,
  });

  res.json({ success: true, updatedAt: now });
});

export default router;
