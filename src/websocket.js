import { WebSocketServer, WebSocket } from 'ws';
import { validateToken } from './auth.js';
import { notepadDb } from './db.js';

class RealtimeHub {
  constructor() {
    this.wss = null;
    /** Map<WebSocket, { sessionId: string, token: string, isAlive: boolean }> */
    this.clients = new Map();
  }

  init(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      // 从 url query 或 header 中解析 token
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');

      const session = validateToken(token);
      if (!session) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Token 无效或已过期' }));
        ws.close(4001, 'Unauthorized');
        return;
      }

      this.clients.set(ws, {
        sessionId: session.id,
        token: session.token,
        isAlive: true,
      });

      // 发送连接成功与当前草稿状态
      const notepad = notepadDb.get.get();
      ws.send(JSON.stringify({
        type: 'INIT',
        notepad: notepad ? notepad.content : '',
        updatedAt: notepad ? notepad.updated_at : Date.now(),
      }));

      ws.on('pong', () => {
        const clientInfo = this.clients.get(ws);
        if (clientInfo) clientInfo.isAlive = true;
      });

      ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handleClientMessage(ws, payload);
        } catch (err) {
          console.error('[WebSocket] 解析消息失败:', err);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[WebSocket] 连接错误:', err);
        this.clients.delete(ws);
      });
    });

    // 定期心跳检测
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, info] of this.clients.entries()) {
        if (!info.isAlive) {
          this.clients.delete(ws);
          ws.terminate();
          continue;
        }
        info.isAlive = false;
        ws.ping();
      }
    }, 30000);

    this.wss.on('close', () => {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    });
  }

  handleClientMessage(ws, payload) {
    const clientInfo = this.clients.get(ws);
    if (!clientInfo) return;

    // 每次通信刷新 token 状态
    const session = validateToken(clientInfo.token);
    if (!session) {
      ws.send(JSON.stringify({ type: 'FORCE_LOGOUT', reason: '会话已失效' }));
      this.clients.delete(ws);
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (payload.type === 'NOTEPAD_UPDATE') {
      const content = typeof payload.content === 'string' ? payload.content : '';
      const now = Date.now();
      notepadDb.save.run({ content, updatedAt: now });

      // 广播给其他客户端（排除当前发件人）
      this.broadcast(
        {
          type: 'NOTEPAD_SYNC',
          content,
          updatedAt: now,
        },
        ws
      );
    } else if (payload.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
    }
  }

  /**
   * 广播消息
   * @param {object} message 
   * @param {WebSocket} [excludeWs] 
   */
  broadcast(message, excludeWs = null) {
    const jsonStr = JSON.stringify(message);
    for (const [ws] of this.clients.entries()) {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        ws.send(jsonStr);
      }
    }
  }

  /**
   * 广播文件列表发生变化
   */
  broadcastFileListUpdated() {
    this.broadcast({ type: 'FILES_SYNC' });
  }

  /**
   * 强制踢出指定 Session 的所有 WebSocket 连接
   * @param {string} sessionId 
   */
  forceLogoutSession(sessionId) {
    for (const [ws, info] of this.clients.entries()) {
      if (info.sessionId === sessionId) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'FORCE_LOGOUT', reason: '当前设备已被远程踢出' }));
          ws.close(4000, 'Kicked out');
        }
        this.clients.delete(ws);
      }
    }
  }

  /**
   * 强制踢出除指定 Token 之外的所有连接
   * @param {string} currentToken 
   */
  forceLogoutOthers(currentToken) {
    for (const [ws, info] of this.clients.entries()) {
      if (info.token !== currentToken) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'FORCE_LOGOUT', reason: '其他设备已批量下线' }));
          ws.close(4000, 'Kicked out');
        }
        this.clients.delete(ws);
      }
    }
  }

  /**
   * 平稳关闭所有 WebSocket 连接与服务
   */
  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [ws] of this.clients.entries()) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {}
    }
    this.clients.clear();
    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
    }
  }
}

export const realtimeHub = new RealtimeHub();
