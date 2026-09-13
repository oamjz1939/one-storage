import express from 'express';
import { requireAuth } from '../auth.js';
import { sessionDb } from '../db.js';
import { realtimeHub } from '../websocket.js';
import { config } from '../config.js';

const router = express.Router();

/**
 * 获取信任设备列表
 * GET /api/devices
 */
router.get('/', requireAuth, (req, res) => {
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
 * POST /api/devices/:id/revoke
 */
router.post('/:id/revoke', requireAuth, (req, res) => {
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
 * POST /api/devices/revoke-others
 */
router.post('/revoke-others', requireAuth, (req, res) => {
  sessionDb.revokeOthers.run(req.token);

  // WebSocket 实时强制断开其他设备
  realtimeHub.forceLogoutOthers(req.token);

  res.json({ success: true, message: '已踢出其他所有设备' });
});

export default router;
