import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { realtimeHub } from './websocket.js';
import { startCleanupJob } from './cleanup.js';
import authRoutes from './routes/authRoutes.js';
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
startCleanupJob(5);

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
