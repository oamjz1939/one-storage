# One Storage 代码质量与架构审查清单 (DESLOPPIFY)

本文档对 One Storage 项目进行了全面代码审查与修复验证。所有 12 项问题均已逐一修复并通过严格自测。

---

## 关键问题 (Critical)

- [x] **设备管理 API 路由路径不一致导致功能彻底失效**
  - 修复方案: 创建 `src/routes/deviceRoutes.js` 独立出设备管理路由，并在 `src/server.js` 中规范挂载至 `/api/devices` 及 `/api/auth/devices`，使前端 `api.js` 请求精确命中。
  - 验证结果: 路由映射对齐，设备列表加载、单个设备注销与批量踢出链路恢复畅通。
- [x] **文件下载链接直接拼接持久 Token 导致身份凭证泄漏**
  - 修复方案: 创建 `src/tickets.js` 引入短期下载 Ticket 机制；在 `src/routes/fileRoutes.js` 中提供 `POST /api/files/:id/ticket` 接口；下载与预览不再支持通过 URL 传主 Token，全面杜绝凭证泄漏。
  - 验证结果: 下载与复制链接统一走 1 小时临时 Ticket，主会话 Token 仅通过 Header 传递，不再暴露于 URL 及历史记录。
- [x] **上传中断/异常残留孤儿物理文件，清理任务无法清理，造成持久磁盘垃圾**
  - 修复方案: 上传过程写入 `${fileId}.upload.tmp` 隔离文件，监听 `aborted`/`close`/`error` 异常即刻清理；只有数据库成功记录后才原子重命名；同时在 `src/cleanup.js` 中增加物理目录反向扫描，自动清除未入库与超时的孤儿文件。
  - 验证结果: 异常中断零残留，后台定时器具备全自动磁盘死垃圾回收能力。
- [x] **登录接口缺少防暴力破解与频率限制**
  - 修复方案: 在 `src/auth.js` 中实现基于 IP 的失败尝试限流保护（5 次失败锁定 15 分钟，10 次失败锁定 1 小时），登录成功自动重置，定时器后台清理过期记录。
  - 验证结果: 连续错误尝试触发 429 锁定，抵御字典爆破。

---

## 中等问题 (Medium)

- [x] **CSS 变量未定义导致同步指示灯与部分状态文本颜色失效**
  - 修复方案: 在 `public/css/style.css` 的 `:root` 中补充 `--success-color`、`--warning-color`、`--danger-color` 等语义兼容别名。
  - 验证结果: 同步指示灯（同步中黄色/已同步绿色）、错误与状态提示颜色完整恢复。
- [x] **文件直接预览接口存在潜在存储型 XSS 漏洞**
  - 修复方案: 在 `/api/files/:id/raw` 接口中注入 `X-Content-Type-Options: nosniff` 与严格 CSP `default-src 'none'; sandbox`；对 HTML/SVG/XML/JS 等潜在执行脚本强制转为附件下载与二进制流，禁止在同源域直接执行。
  - 验证结果: 杜绝同源上下文恶意脚本执行风险。
- [x] **前端离线状态缺乏视觉提示与未同步数据保护**
  - 修复方案: 在 `public/js/notepad.js` 中加入输入自动本地存储（`localStorage` 暂存）；断网时提示离线未同步；网络/WebSocket 恢复时自动比对时间戳并将离线草稿自动同步回服务端。
  - 验证结果: 掉线期间打字内容不丢失，重连后自动上传。
- [x] **缺乏应用优雅停机 (Graceful Shutdown) 处理**
  - 修复方案: 在 `src/server.js` 监听 `SIGTERM` 与 `SIGINT` 信号；平稳停止清理定时器，关闭所有 WebSocket 客户端连接，关闭 HTTP 服务，执行 SQLite `wal_checkpoint(TRUNCATE)` 并安全调用 `db.close()`。
  - 验证结果: 服务停止和容器重启时数据库连接优雅关闭，WAL 完整截断合并。

---

## 可以改善 (Improvement)

- [x] **前端单体文件代码职责过重，未做组件化拆分**
  - 修复方案: 将原 440 行的 `public/js/app.js` 拆解为单一职责模块：`notepad.js` (草稿纸与离线缓存)、`devices.js` (设备管理模态框)、`files.js` (文件列表、下载、倒计时)、`app.js` (核心协调器)。
  - 验证结果: 模块解耦，维护性与测试性显著提高。
- [x] **冗余未使用的后端路由**
  - 修复方案: 激活 `src/routes/notepadRoutes.js` 中的 `POST /api/notepad` 接口，将其作为 WebSocket 断开时的自动降级 HTTP 同步通道。
  - 验证结果: 死代码消除，网络波动时草稿仍可通过 HTTP 自动保存。
- [x] **密码比较未使用恒定时间比较**
  - 修复方案: 在 `src/auth.js` 中使用 `crypto.timingSafeEqual` 对输入的 SHA-256 哈希值与正确密码哈希值进行恒定时间比对。
  - 验证结果: 彻底消除基于比较耗时的微秒级时序攻击（Timing Attack）。
- [x] **文件过期倒计时界面不会自动移除已过期项目**
  - 修复方案: 在 `public/js/files.js` 倒计时每 5 秒轮询中，一旦检测到有条目剩余时间归零，自动触发静默刷新，从 DOM 中平滑剔除。
  - 验证结果: 倒计时归零后已过期文件立即自动从界面消失。
