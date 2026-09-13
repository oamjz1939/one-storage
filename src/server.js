import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import db from './db.js';
import { realtimeHub } from './websocket.js';
import { startCleanupJob, stopCleanupJob } from './cleanup.js';
import authRoutes from './routes/authRoutes.js';
import deviceRoutes from './routes/deviceRoutes.js';
import notepadRoutes from './routes/notepadRoutes.js';
import fileRoutes from './routes/fileRoutes.js';

const app = express();
const server = http.createServer(app);

// 基础中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 托管前端静态资源
const publicDir = path.resolve('public');
app.use(express.static(publicDir));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/auth/devices', deviceRoutes);
app.use('/api/notepad', notepadRoutes);
app.use('/api/files', fileRoutes);

// 系统信息查询接口 (前端获取配置)
app.get('/api/config', (req, res) => {
  res.json({
    fileExpireHours: config.FILE_EXPIRE_HOURS,
    sessionExpireDays: config.SESSION_EXPIRE_DAYS,
    maxFileSizeMb: config.MAX_FILE_SIZE_MB,
  });
});

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// 初始化 WebSocket 服务
realtimeHub.init(server);

// 启动后台定时清理任务 (默认 5 分钟检查一次)
const cleanupTimer = startCleanupJob(5);

// 启动 HTTP 监听
server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`One Storage 服务已启动`);
  console.log(`访问地址: http://localhost:${config.PORT}`);
  console.log(`文件过期: ${config.FILE_EXPIRE_HOURS} 小时`);
  console.log(`设备免密: ${config.SESSION_EXPIRE_DAYS} 天`);
  console.log(`持久目录: ${config.DATA_DIR}`);
  console.log(`=========================================`);
});

// 优雅停机 (Graceful Shutdown)
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Server] 收到 ${signal} 信号，正在平稳关闭服务...`);

  // 1. 停止定时清理任务
  stopCleanupJob(cleanupTimer);

  // 2. 关闭所有 WebSocket 连接
  realtimeHub.close();

  // 3. 停止接收新 HTTP 请求并平稳关闭
  server.close(() => {
    console.log('[Server] HTTP 服务已安全停止');

    // 4. 关闭 SQLite 数据库并执行 WAL checkpoint
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[Server] SQLite 数据库已平稳关闭并完成 WAL 检查点');
    } catch (err) {
      console.error('[Server] 关闭数据库时出错:', err.message);
    }

    process.exit(0);
  });

  // 超时强制退出保护 (5 秒)
  setTimeout(() => {
    console.error('[Server] 关闭超时，强制终止进程');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
