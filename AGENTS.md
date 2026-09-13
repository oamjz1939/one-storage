# One Storage

单用户私有实时云草稿纸与 24 小时临时文件快传站。

## 技术栈与架构
- **后端**: Node.js (ESM), Express 4, WebSocket (`ws`), SQLite (`better-sqlite3`), `busboy` 流式大文件上传
- **前端**: 原生 JS/CSS 单页应用 (Google Drive / Material Design 3 风格，位于 `public/`)
- **数据持久化**: 默认存放在 `./data` (`storage.db` 数据库 + `uploads/` 物理文件)

## 关键环境变量
| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `APP_PASSWORD` | `admin123` | 全局访问密码 |
| `PORT` | `8080` | 服务监听端口 |
| `DATA_DIR` | `./data` | 数据持久化目录 |
| `FILE_EXPIRE_HOURS` | `24` | 文件自动物理销毁时间 (小时) |
| `SESSION_EXPIRE_DAYS` | `14` | 信任设备免密保持时间 (天) |
| `MAX_FILE_SIZE_MB` | `5120` | 单文件最大体积限制 (MB) |

## 部署指南

### 1. Docker Compose 部署 (生产推荐)
1. 编辑 `docker-compose.yml` 中的 `APP_PASSWORD` 等环境变量。
2. 启动容器：
```bash
docker compose up -d --build
```
3. 停止与查看日志：
```bash
docker compose logs -f
docker compose down
```

### 2. 本地 / 裸机 Node.js 部署
依赖环境：Node.js >= 20.0.0
```bash
npm install
APP_PASSWORD="your_password" PORT=8080 npm start
```

## 核心工作机制
- **认证与设备管理**: 单密码验证后签发 Device Token，记录在 `sessions` 表；支持设备列表查看与远程强制踢出（通过 WebSocket 下发 `FORCE_LOGOUT`）。
- **草稿纸同步**: 客户端输入 300ms 防抖，通过 WebSocket 广播更新，以最新输入为准覆盖。
- **文件流式上传与清理**: `busboy` 直接管道写入磁盘，不占内存；后台定时任务（默认 5 分钟间隔）自动物理删除已过期的文件记录及实体文件。
