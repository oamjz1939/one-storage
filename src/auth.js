import crypto from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import { config } from './config.js';
import { sessionDb, settingsDb } from './db.js';

/**
 * 初始化密码系统与智能双通道监听：
 * 说明：此检测在服务进程启动（冷启动）时执行。
 * 若管理员通过 SSH 修改了 docker-compose.yml 中的环境变量 APP_PASSWORD 并重启容器（docker compose up -d），
 * 服务在启动加载阶段自动检测到环境变量变更，强制覆盖并清空旧的自定义密码，实现终极兜底恢复。
 */
export function initPasswordSystem() {
  const currentEnvPass = config.APP_PASSWORD;
  const lastEnvRow = settingsDb.get.get('last_env_password');

  if (!lastEnvRow) {
    settingsDb.set.run('last_env_password', currentEnvPass);
  } else if (lastEnvRow.value !== currentEnvPass) {
    console.log('=====================================================');
    console.log('[Auth] 检测到外部环境变量 APP_PASSWORD 变更，已强制覆盖并重置密码！');
    console.log('=====================================================');
    settingsDb.set.run('last_env_password', currentEnvPass);
    settingsDb.delete.run('custom_password');
  }
}

// 模块加载时即刻执行环境变量变更检查
initPasswordSystem();

/**
 * 获取当前实际生效的访问密码 (优先使用网页自定义密码，回退至环境变量)
 */
export function getEffectivePassword() {
  const customRow = settingsDb.get.get('custom_password');
  return customRow ? customRow.value : config.APP_PASSWORD;
}

/**
 * 修改访问密码
 */
export function changePassword(oldPassword, newPassword) {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length === 0) {
    return { success: false, message: '新密码不能为空' };
  }

  const currentPass = getEffectivePassword();
  if (!verifyPassword(oldPassword, currentPass)) {
    return { success: false, message: '原密码错误' };
  }

  settingsDb.set.run('custom_password', newPassword.trim());
  return { success: true };
}

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

  // 2. 恒定时间比对密码 (使用当前实际生效的密码)
  const isMatch = verifyPassword(password, getEffectivePassword());

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
