import { api } from './api.js';
import { wsClient } from './ws.js';

const DRAFT_KEY = 'one_storage_notepad_draft';
const DRAFT_TIME_KEY = 'one_storage_draft_updated';

export class NotepadManager {
  constructor({ textarea, charCountEl, syncStatusEl, btnCopy, btnClear, showToast }) {
    this.textarea = textarea;
    this.charCountEl = charCountEl;
    this.syncStatusEl = syncStatusEl;
    this.btnCopy = btnCopy;
    this.btnClear = btnClear;
    this.showToast = showToast;
    this.debounceTimer = null;
    this.serverUpdatedAt = 0;

    this.initEvents();
  }

  initEvents() {
    this.textarea.addEventListener('input', () => this.handleInput());
    this.btnCopy.addEventListener('click', () => this.handleCopy());
    this.btnClear.addEventListener('click', () => this.handleClear());

    // 监听 WebSocket 同步事件
    wsClient.on('init', (data) => {
      if (data.notepad !== undefined) {
        this.applyServerContent(data.notepad, data.updatedAt || 0);
      }
    });

    wsClient.on('notepad_sync', (data) => {
      if (data.content !== undefined) {
        this.applyServerContent(data.content, data.updatedAt || 0);
      }
    });

    // 监听在线重连，自动恢复未上报的离线草稿
    wsClient.on('status', ({ connected }) => {
      if (connected) {
        this.syncLocalDraftToServer();
      }
    });
  }

  updateCharCount() {
    const text = this.textarea.value;
    this.charCountEl.textContent = `${text.length} 字`;
  }

  setSyncStatus(text, type = 'success') {
    let color = 'var(--success-color)';
    if (type === 'warning') color = 'var(--warning-color)';
    if (type === 'error') color = 'var(--danger-color)';

    this.syncStatusEl.innerHTML = `<span class="dot-indicator" style="background: ${color};"></span> ${text}`;
  }

  handleInput() {
    this.updateCharCount();
    this.setSyncStatus('同步中', 'warning');

    const text = this.textarea.value;
    const now = Date.now();

    // 离线保护：无论网络状态如何，先暂存本地存储
    try {
      localStorage.setItem(DRAFT_KEY, text);
      localStorage.setItem(DRAFT_TIME_KEY, now.toString());
    } catch {}

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      if (wsClient.isConnected) {
        wsClient.sendNotepadUpdate(text);
        this.setSyncStatus('已同步', 'success');
        this.clearLocalDraft();
      } else {
        // WebSocket 断开时，降级使用 HTTP POST 接口同步 (修复冗余路由利用)
        try {
          await api.saveNotepad(text);
          this.setSyncStatus('已同步 (HTTP)', 'success');
          this.clearLocalDraft();
        } catch {
          this.setSyncStatus('离线未同步 (已保存在本地)', 'warning');
        }
      }
    }, 300);
  }

  async syncLocalDraftToServer() {
    const localDraft = localStorage.getItem(DRAFT_KEY);
    const draftTime = parseInt(localStorage.getItem(DRAFT_TIME_KEY) || '0', 10);

    if (localDraft !== null && draftTime > this.serverUpdatedAt) {
      this.setSyncStatus('正在恢复本地草稿...', 'warning');
      try {
        if (wsClient.isConnected) {
          wsClient.sendNotepadUpdate(localDraft);
        } else {
          await api.saveNotepad(localDraft);
        }
        this.clearLocalDraft();
        this.setSyncStatus('已同步', 'success');
      } catch (err) {
        console.error('自动补发离线草稿失败:', err);
      }
    }
  }

  clearLocalDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_TIME_KEY);
    } catch {}
  }

  applyServerContent(content, updatedAt) {
    this.serverUpdatedAt = updatedAt;
    const localDraft = localStorage.getItem(DRAFT_KEY);
    const draftTime = parseInt(localStorage.getItem(DRAFT_TIME_KEY) || '0', 10);

    // 如果本地有更新的离线草稿未同步，优先保护本地编辑
    if (localDraft !== null && draftTime > updatedAt) {
      this.syncLocalDraftToServer();
      return;
    }

    if (this.textarea.value !== content) {
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      this.textarea.value = content;
      this.updateCharCount();
      try {
        this.textarea.setSelectionRange(start, end);
      } catch {}
    }
    this.setSyncStatus('已同步', 'success');
  }

  async handleCopy() {
    const text = this.textarea.value;
    if (!text) {
      return this.showToast('内容为空', 'info');
    }

    try {
      await navigator.clipboard.writeText(text);
      this.showToast('已复制', 'success');
    } catch {
      this.textarea.select();
      document.execCommand('copy');
      this.showToast('已复制', 'success');
    }
  }

  async handleClear() {
    if (!this.textarea.value) return;
    if (confirm('确定清空文本？')) {
      this.textarea.value = '';
      this.updateCharCount();
      this.clearLocalDraft();
      if (wsClient.isConnected) {
        wsClient.sendNotepadUpdate('');
      } else {
        await api.saveNotepad('').catch(() => {});
      }
      this.setSyncStatus('已清空', 'success');
      this.showToast('已清空', 'info');
    }
  }

  async loadInitial() {
    try {
      const res = await api.getNotepad();
      this.applyServerContent(res.content || '', res.updatedAt || 0);
    } catch (err) {
      console.error('加载文本失败:', err);
    }
  }
}
