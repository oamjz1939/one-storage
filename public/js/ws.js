import { authState } from './api.js';

class WebSocketClient {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.isConnected = false;
    this.isManualClosed = false;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const cbs = this.listeners.get(event) || [];
    for (const cb of cbs) {
      cb(data);
    }
  }

  connect() {
    const token = authState.getToken();
    if (!token) return;

    this.isManualClosed = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnected = true;
      this.emit('status', { connected: true });
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.emit('message', msg);

        if (msg.type === 'NOTEPAD_SYNC') {
          this.emit('notepad_sync', msg);
        } else if (msg.type === 'INIT') {
          this.emit('init', msg);
        } else if (msg.type === 'FILES_SYNC') {
          this.emit('files_sync', msg);
        } else if (msg.type === 'FORCE_LOGOUT') {
          this.emit('force_logout', msg);
        }
      } catch (err) {
        console.error('[WS] 接收数据解析失败:', err);
      }
    };

    this.ws.onclose = (e) => {
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('status', { connected: false });

      if (e.code === 4001 || e.code === 4000) {
        // 未授权或被踢出，不重连
        this.emit('force_logout', { reason: '连接被拒绝或已被下线' });
        return;
      }

      if (!this.isManualClosed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      this.isConnected = false;
      this.emit('status', { connected: false });
    };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, 25000);
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (authState.isLoggedIn() && !this.isManualClosed) {
        this.connect();
      }
    }, 3000);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendNotepadUpdate(content) {
    this.send({
      type: 'NOTEPAD_UPDATE',
      content,
    });
  }

  disconnect() {
    this.isManualClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.emit('status', { connected: false });
  }
}

export const wsClient = new WebSocketClient();
