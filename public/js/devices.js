import { api } from './api.js';

export class DevicesModalManager {
  constructor({ modalEl, listEl, btnOpen, btnClose, btnRevokeOthers, showToast }) {
    this.modalEl = modalEl;
    this.listEl = listEl;
    this.btnOpen = btnOpen;
    this.btnClose = btnClose;
    this.btnRevokeOthers = btnRevokeOthers;
    this.showToast = showToast;

    this.initEvents();
  }

  initEvents() {
    this.btnOpen.addEventListener('click', async () => {
      this.modalEl.style.display = 'flex';
      await this.loadDevices();
    });

    this.btnClose.addEventListener('click', () => {
      this.modalEl.style.display = 'none';
    });

    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) {
        this.modalEl.style.display = 'none';
      }
    });

    this.btnRevokeOthers.addEventListener('click', () => this.handleRevokeOthers());
  }

  async loadDevices() {
    this.listEl.innerHTML = '<div style="text-align: center; padding: 1.5rem; color: var(--text-muted);">加载中...</div>';
    try {
      const res = await api.getDevices();
      const devices = res.devices || [];

      if (devices.length === 0) {
        this.listEl.innerHTML = '<div class="empty-state">无设备</div>';
        return;
      }

      this.listEl.innerHTML = '';
      for (const d of devices) {
        const item = document.createElement('div');
        item.className = `device-item ${d.isCurrent ? 'current' : ''}`;

        const lastActiveTime = new Date(d.lastActiveAt).toLocaleString('zh-CN', { hour12: false });

        item.innerHTML = `
          <div class="device-meta">
            <div class="device-title">
              <span>${d.deviceName || '未知设备'}</span>
              ${d.isCurrent ? '<span class="device-badge">当前设备</span>' : ''}
            </div>
            <div class="device-sub">
              <span>IP: ${d.ip}</span> · 
              <span>活跃: ${lastActiveTime}</span>
            </div>
          </div>
          <div>
            ${
              d.isCurrent
                ? ''
                : `<button class="btn btn-danger-text btn-sm btn-kick" data-id="${d.id}">踢出</button>`
            }
          </div>
        `;

        if (!d.isCurrent) {
          item.querySelector('.btn-kick').addEventListener('click', async () => {
            if (confirm(`确定踢出 ${d.deviceName}？`)) {
              try {
                await api.revokeDevice(d.id);
                this.showToast('已踢出', 'success');
                this.loadDevices();
              } catch (err) {
                this.showToast(`操作失败: ${err.message}`, 'error');
              }
            }
          });
        }

        this.listEl.appendChild(item);
      }
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty-state" style="color: var(--danger-color);">加载失败: ${err.message}</div>`;
    }
  }

  async handleRevokeOthers() {
    if (confirm('确定踢出除当前设备外的所有其他设备？')) {
      try {
        await api.revokeOthers();
        this.showToast('已踢出其他设备', 'success');
        this.loadDevices();
      } catch (err) {
        this.showToast(`操作失败: ${err.message}`, 'error');
      }
    }
  }
}
