import crypto from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import { config } from './config.js';
import { sessionDb } from './db.js';

// 登录频率限制存储: Map<ip, { failedAttempts: number, lockedUntil: number, firstAttemptAt: number }>
const loginAttempts = new Map();

// 定期清理过期的 IP 限流记录 (每 10 分钟)
const attemptCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (record.lockedUntil < now && now - record.firstAttemptAt > 15 * 60 * 1000) {
      loginAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000);
attemptCleanupTimer.unref();

/**
 * 恒定时间密码比对，防止时序攻击 (Timing Attack)
 */
export function verifyPassword(inputPassword, correctPassword) {
  if (typeof inputPassword !== 'string' || typeof correctPassword !== 'string') {
    return false;
  }
  const inputHash = crypto.createHash('sha256').update(inputPassword).digest();
  const correctHash = crypto.createHash('sha256').update(correctPassword).digest();
  return crypto.timingSafeEqual(inputHash, correctHash);
}

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
 * 校验密码并创建 Session (带防暴破与限流机制)
 */
export function authenticateAndCreateSession({ password, ip, userAgent }) {
  const clientIp = ip || 'unknown';
  const now = Date.now();

  // 1. 检查 IP 是否处于封禁锁定期
  const attemptRecord = loginAttempts.get(clientIp);
  if (attemptRecord && attemptRecord.lockedUntil > now) {
    const remainingMinutes = Math.ceil((attemptRecord.lockedUntil - now) / 60000);
    return {
      success: false,
      statusCode: 429,
      message: `尝试次数过多，请在 ${remainingMinutes} 分钟后再试`,
    };
  }

  // 2. 恒定时间比对密码
  const isMatch = verifyPassword(password, config.APP_PASSWORD);

  if (!isMatch) {
    // 记录失败尝试
    const record = attemptRecord || { failedAttempts: 0, lockedUntil: 0, firstAttemptAt: now };
    record.failedAttempts += 1;

    // 5 次失败，锁定 15 分钟；10 次失败，锁定 1 小时
    if (record.failedAttempts >= 10) {
      record.lockedUntil = now + 60 * 60 * 1000;
    } else if (record.failedAttempts >= 5) {
      record.lockedUntil = now + 15 * 60 * 1000;
    }

    loginAttempts.set(clientIp, record);

    const remainingAttempts = Math.max(0, 5 - record.failedAttempts);
    const hint = remainingAttempts > 0 ? ` (还剩 ${remainingAttempts} 次尝试机会)` : ' (已被临时锁定)';
    return { success: false, statusCode: 401, message: `访问密码错误${hint}` };
  }

  // 3. 登录成功，清除该 IP 失败记录
  loginAttempts.delete(clientIp);

  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomUUID();
  const deviceName = parseDeviceName(userAgent);

  sessionDb.create.run({
    id,
    token,
    ip: clientIp,
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
 * Express 鉴权中间件 (从 Authorization Bearer 头获取 Token)
 */
export function requireAuth(req, res, next) {
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  const session = validateToken(token);
  if (!session) {
    return res.status(401).json({ error: '未授权或登录已过期/被踢出', code: 'UNAUTHORIZED' });
  }

  req.session = session;
  req.token = token;
  next();
}
