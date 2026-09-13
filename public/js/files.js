import { api } from './api.js';
import { wsClient } from './ws.js';

export class FilesManager {
  constructor({ listContainer, emptyStateEl, countEl, btnRefresh, showToast }) {
    this.listContainer = listContainer;
    this.emptyStateEl = emptyStateEl;
    this.countEl = countEl;
    this.btnRefresh = btnRefresh;
    this.showToast = showToast;

    this.files = [];
    this.countdownTimer = null;
    this.serverTimeOffset = 0;

    this.initEvents();
  }

  initEvents() {
    this.btnRefresh.addEventListener('click', () => {
      this.loadFiles();
      this.showToast('已刷新', 'info');
    });

    wsClient.on('files_sync', () => {
      this.loadFiles(true);
    });
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  formatRemainingTime(expiresAt) {
    const now = Date.now() + this.serverTimeOffset;
    const diffSec = Math.floor((expiresAt - now) / 1000);

    if (diffSec <= 0) return '已过期';

    const hours = Math.floor(diffSec / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  render() {
    this.countEl.textContent = this.files.length;

    if (this.files.length === 0) {
      this.listContainer.innerHTML = '';
      this.listContainer.appendChild(this.emptyStateEl);
      this.emptyStateEl.style.display = 'block';
      return;
    }

    this.emptyStateEl.style.display = 'none';
    this.listContainer.innerHTML = '';

    for (const file of this.files) {
      const item = document.createElement('div');
      item.className = 'file-item';

      item.innerHTML = `
        <div class="file-info">
          <span class="file-name" title="${file.originalName}">${file.originalName}</span>
          <div class="file-submeta">
            <span>${this.formatBytes(file.fileSize)}</span>
            <span>·</span>
            <span class="expire-countdown" data-expires="${file.expiresAt}">
              ${this.formatRemainingTime(file.expiresAt)}
            </span>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-primary btn-sm btn-download-file" data-id="${file.id}" title="安全下载">
            下载
          </button>
          <button class="btn btn-tonal btn-sm btn-copy-link" data-id="${file.id}" title="复制临时下载链接">
            复制链接
          </button>
          <button class="btn btn-danger-text btn-sm btn-delete-file" data-id="${file.id}" title="删除">
            删除
          </button>
        </div>
      `;

      // 1. 安全下载：通过短期 Ticket，不泄露全局 Session Token
      item.querySelector('.btn-download-file').addEventListener('click', async () => {
        try {
          const res = await api.getDownloadTicket(file.id);
          const a = document.createElement('a');
          a.href = res.downloadUrl;
          a.download = file.originalName;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (err) {
          this.showToast(`下载失败: ${err.message}`, 'error');
        }
      });

      // 2. 复制临时分享/下载直链 (Ticket 机制)
      item.querySelector('.btn-copy-link').addEventListener('click', async () => {
        try {
          const res = await api.getDownloadTicket(file.id);
          const fullUrl = `${window.location.origin}${res.downloadUrl}`;
          await navigator.clipboard.writeText(fullUrl);
          this.showToast('已复制临时下载链接', 'success');
        } catch (err) {
          this.showToast(`复制失败: ${err.message}`, 'error');
        }
      });

      // 3. 删除文件
      item.querySelector('.btn-delete-file').addEventListener('click', async () => {
        if (confirm(`确定删除 ${file.originalName}？`)) {
          try {
            await api.deleteFile(file.id);
            this.showToast('已删除', 'info');
            this.loadFiles();
          } catch (err) {
            this.showToast(`删除失败: ${err.message}`, 'error');
          }
        }
      });

      this.listContainer.appendChild(item);
    }
  }

  async loadFiles(isSilent = false) {
    try {
      const res = await api.getFiles();
      this.files = res.files || [];
      if (res.serverTime) {
        this.serverTimeOffset = res.serverTime - Date.now();
      }
      this.render();
    } catch (err) {
      if (!isSilent) this.showToast(`获取文件失败: ${err.message}`, 'error');
    }
  }

  startCountdown() {
    this.stopCountdown();
    this.countdownTimer = setInterval(() => {
      const countSpans = this.listContainer.querySelectorAll('.expire-countdown');
      let hasExpired = false;

      countSpans.forEach((span) => {
        const expires = parseInt(span.getAttribute('data-expires'), 10);
        if (expires) {
          const remaining = this.formatRemainingTime(expires);
          span.textContent = remaining;
          if (remaining === '已过期') {
            hasExpired = true;
          }
        }
      });

      // 倒计时归零时，自动重新加载文件列表，从 DOM 彻底移除过期文件
      if (hasExpired) {
        this.loadFiles(true);
      }
    }, 5000);
  }

  stopCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
