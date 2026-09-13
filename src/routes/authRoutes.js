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
    return res.status(401).json({ error: result.message });
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
 * 获取信任设备列表
 */
router.get('/devices', requireAuth, (req, res) => {
  const maxAgeMs = config.SESSION_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
  const activeSince = Date.now() - maxAgeMs;

  const rawSessions = sessionDb.listActive.all(activeSince);
  const devices = rawSessions.map((s) => ({
    id: s.id,
    ip: s.ip,
    deviceName: s.device_name,
    createdAt: s.created_at,
    lastActiveAt: s.last_active_at,
    isCurrent: s.id === req.session.id,
  }));

  res.json({ devices });
});

/**
 * 踢出指定设备
 */
router.post('/devices/:id/revoke', requireAuth, (req, res) => {
  const targetId = req.params.id;

  const targetSession = sessionDb.findById.get(targetId);
  if (!targetSession) {
    return res.status(404).json({ error: '设备不存在' });
  }

  sessionDb.revokeById.run(targetId);

  // WebSocket 实时强制断开目标设备
  realtimeHub.forceLogoutSession(targetId);

  res.json({ success: true, message: '设备已被成功踢出' });
});

/**
 * 踢出其他所有设备
 */
router.post('/devices/revoke-others', requireAuth, (req, res) => {
  sessionDb.revokeOthers.run(req.token);

  // WebSocket 实时强制断开其他设备
  realtimeHub.forceLogoutOthers(req.token);

  res.json({ success: true, message: '已踢出其他所有设备' });
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
