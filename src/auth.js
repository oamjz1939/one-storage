import crypto from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import { config } from './config.js';
import { sessionDb } from './db.js';

/**
 * 解析 User-Agent 生成易读的设备名称
 */
export function parseDeviceName(userAgentString) {
  if (!userAgentString) return '未知设备';
  const parser = new UAParser(userAgentString);
  const os = parser.getOS();
  const browser = parser.getBrowser();
  const device = parser.getDevice();

  const osStr = os.name ? `${os.name}${os.version ? ' ' + os.version : ''}` : '';
  const browserStr = browser.name ? `${browser.name}${browser.version ? ' ' + browser.version.split('.')[0] : ''}` : '';
  const deviceModel = device.model ? ` (${device.model})` : '';

  if (osStr && browserStr) {
    return `${osStr} · ${browserStr}${deviceModel}`;
  } else if (osStr) {
    return `${osStr}${deviceModel}`;
  } else if (browserStr) {
    return `${browserStr}${deviceModel}`;
  }
  return '未知浏览器/设备';
}

/**
 * 校验密码并创建 Session
 */
export function authenticateAndCreateSession({ password, ip, userAgent }) {
  if (password !== config.APP_PASSWORD) {
    return { success: false, message: '访问密码错误' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomUUID();
  const now = Date.now();
  const deviceName = parseDeviceName(userAgent);

  sessionDb.create.run({
    id,
    token,
    ip: ip || '未知IP',
    userAgent: userAgent || '',
    deviceName,
    createdAt: now,
    lastActiveAt: now,
  });

  return {
    success: true,
    token,
    deviceId: id,
    deviceName,
  };
}

/**
 * 验证 Token 是否合法且在有效期内（14天）
 */
export function validateToken(token) {
  if (!token || typeof token !== 'string') return null;

  const session = sessionDb.findByToken.get(token);
  if (!session) return null;

  const maxAgeMs = config.SESSION_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (now - session.created_at > maxAgeMs) {
    sessionDb.revokeById.run(session.id);
    return null;
  }

  // 刷新活跃时间
  sessionDb.touch.run(now, token);
  return session;
}

/**
 * Express 鉴权中间件
 */
export function requireAuth(req, res, next) {
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  const session = validateToken(token);
  if (!session) {
    return res.status(401).json({ error: '未授权或登录已过期/被踢出', code: 'UNAUTHORIZED' });
  }

  req.session = session;
  req.token = token;
  next();
}
