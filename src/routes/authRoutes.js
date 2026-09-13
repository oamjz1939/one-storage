import express from 'express';
import { authenticateAndCreateSession, requireAuth } from '../auth.js';
import { sessionDb } from '../db.js';
import { realtimeHub } from '../websocket.js';
import { config } from '../config.js';

const router = express.Router();

/**
 * 密码登录
 */
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';

  const result = authenticateAndCreateSession({
    password,
    ip: typeof ip === 'string' ? ip.split(',')[0].trim() : ip,
    userAgent,
  });

  if (!result.success) {
    return res.status(result.statusCode || 401).json({ error: result.message });
  }

  res.json({
    token: result.token,
    deviceId: result.deviceId,
    deviceName: result.deviceName,
    expiresInDays: config.SESSION_EXPIRE_DAYS,
  });
});

/**
 * 校验当前登录状态
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    deviceId: req.session.id,
    deviceName: req.session.device_name,
    ip: req.session.ip,
    createdAt: req.session.created_at,
  });
});

/**
 * 退出当前设备
 */
router.post('/logout', requireAuth, (req, res) => {
  sessionDb.revokeById.run(req.session.id);
  realtimeHub.forceLogoutSession(req.session.id);
  res.json({ success: true });
});

export default router;
