import { api, authState, setUnauthorizedHandler } from './api.js';
import { wsClient } from './ws.js';
import { initUploader } from './uploader.js';

// DOM 元素引用
const lockScreen = document.getElementById('lock-screen');
const lockCard = document.getElementById('lock-card');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');

const wsStatus = document.getElementById('ws-status');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

const notepadInput = document.getElementById('notepad-input');
const notepadCharCount = document.getElementById('notepad-char-count');
const notepadSyncStatus = document.getElementById('notepad-sync-status');
const btnCopyNotepad = document.getElementById('btn-copy-notepad');
const btnClearNotepad = document.getElementById('btn-clear-notepad');

const fileListContainer = document.getElementById('file-list');
const emptyState = document.getElementById('empty-state');
const fileCountSpan = document.getElementById('file-count');
const btnRefreshFiles = document.getElementById('btn-refresh-files');

const btnDevices = document.getElementById('btn-devices');
const devicesModal = document.getElementById('devices-modal');
const devicesList = document.getElementById('devices-list');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnRevokeOthers = document.getElementById('btn-revoke-others');
const btnLogout = document.getElementById('btn-logout');

let notepadDebounceTimer = null;
let currentFiles = [];
let countdownTimer = null;
let serverTimeOffset = 0;

// 1. 全局 Toast 提示工具 (无 emoji)
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 2500);
}

// 2. 鉴权与锁屏处理
function showLockScreen() {
  lockScreen.style.display = 'flex';
  wsClient.disconnect();
  stopCountdown();
  passwordInput.value = '';
  setTimeout(() => passwordInput.focus(), 100);
}

function hideLockScreen() {
  lockScreen.style.display = 'none';
  wsClient.connect();
  loadNotepad();
  loadFiles();
  startCountdown();
}

setUnauthorizedHandler(() => {
  showToast('登录已失效', 'error');
  showLockScreen();
});

// 登录表单提交
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = passwordInput.value.trim();
  if (!password) return;

  try {
    await api.login(password);
    showToast('已解锁', 'success');
    hideLockScreen();
  } catch (err) {
    showToast(err.message || '密码错误', 'error');
    lockCard.classList.add('shake');
    setTimeout(() => lockCard.classList.remove('shake'), 350);
  }
});

// 锁屏
btnLogout.addEventListener('click', async () => {
  if (confirm('确定锁定当前设备？')) {
    await api.logout();
    showToast('已锁定', 'info');
    showLockScreen();
  }
});

// 3. WebSocket 状态处理
wsClient.on('status', ({ connected }) => {
  if (connected) {
    statusDot.className = 'status-dot online';
    statusText.textContent = '在线';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = '连接中';
  }
});

wsClient.on('init', (data) => {
  if (data.notepad !== undefined) {
    notepadInput.value = data.notepad;
    updateCharCount();
  }
});

wsClient.on('notepad_sync', (data) => {
  if (notepadInput.value !== data.content) {
    const start = notepadInput.selectionStart;
    const end = notepadInput.selectionEnd;
    notepadInput.value = data.content;
    updateCharCount();
    try {
      notepadInput.setSelectionRange(start, end);
    } catch {}
  }
  setSyncStatus('已同步', 'success');
});

wsClient.on('files_sync', () => {
  loadFiles(true);
});

wsClient.on('force_logout', (data) => {
  showToast(data.reason || '设备已被下线', 'error');
  authState.clearToken();
  showLockScreen();
});

// 4. 文本草稿纸
function updateCharCount() {
  const text = notepadInput.value;
  notepadCharCount.textContent = `${text.length} 字`;
}

function setSyncStatus(text, type = 'success') {
  const color = type === 'success' ? 'var(--success-color)' : 'var(--warning-color)';
  notepadSyncStatus.innerHTML = `<span class="dot-indicator" style="background: ${color};"></span> ${text}`;
}

notepadInput.addEventListener('input', () => {
  updateCharCount();
  setSyncStatus('同步中', 'warning');

  if (notepadDebounceTimer) {
    clearTimeout(notepadDebounceTimer);
  }

  notepadDebounceTimer = setTimeout(() => {
    const text = notepadInput.value;
    wsClient.sendNotepadUpdate(text);
    setSyncStatus('已同步', 'success');
  }, 300);
});

btnCopyNotepad.addEventListener('click', async () => {
  const text = notepadInput.value;
  if (!text) {
    return showToast('内容为空', 'info');
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制', 'success');
  } catch {
    notepadInput.select();
    document.execCommand('copy');
    showToast('已复制', 'success');
  }
});

btnClearNotepad.addEventListener('click', () => {
  if (!notepadInput.value) return;
  if (confirm('确定清空文本？')) {
    notepadInput.value = '';
    updateCharCount();
    wsClient.sendNotepadUpdate('');
    setSyncStatus('已清空', 'success');
    showToast('已清空', 'info');
  }
});

async function loadNotepad() {
  try {
    const res = await api.getNotepad();
    notepadInput.value = res.content || '';
    updateCharCount();
  } catch (err) {
    console.error('加载文本失败:', err);
  }
}

// 5. 文件管理
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatRemainingTime(expiresAt) {
  const now = Date.now() + serverTimeOffset;
  const diffSec = Math.floor((expiresAt - now) / 1000);

  if (diffSec <= 0) return '已过期';
  
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function renderFileList() {
  fileCountSpan.textContent = currentFiles.length;

  if (currentFiles.length === 0) {
    fileListContainer.innerHTML = '';
    fileListContainer.appendChild(emptyState);
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  fileListContainer.innerHTML = '';

  for (const file of currentFiles) {
    const item = document.createElement('div');
    item.className = 'file-item';

    item.innerHTML = `
      <div class="file-info">
        <span class="file-name" title="${file.originalName}">${file.originalName}</span>
        <div class="file-submeta">
          <span>${formatBytes(file.fileSize)}</span>
          <span>·</span>
          <span class="expire-countdown" data-expires="${file.expiresAt}">
            ${formatRemainingTime(file.expiresAt)}
          </span>
        </div>
      </div>
      <div class="file-actions">
        <a href="/api/files/${file.id}/download?token=${authState.getToken()}" class="btn btn-primary btn-sm" download title="下载">
          下载
        </a>
        <button class="btn btn-tonal btn-sm btn-copy-link" data-id="${file.id}" title="复制链接">
          复制链接
        </button>
        <button class="btn btn-danger-text btn-sm btn-delete-file" data-id="${file.id}" title="删除">
          删除
        </button>
      </div>
    `;

    item.querySelector('.btn-copy-link').addEventListener('click', async () => {
      const downloadUrl = `${window.location.origin}/api/files/${file.id}/download?token=${authState.getToken()}`;
      try {
        await navigator.clipboard.writeText(downloadUrl);
        showToast('已复制链接', 'success');
      } catch {
        showToast('复制失败', 'error');
      }
    });

    item.querySelector('.btn-delete-file').addEventListener('click', async () => {
      if (confirm(`确定删除 ${file.originalName}？`)) {
        try {
          await api.deleteFile(file.id);
          showToast('已删除', 'info');
          loadFiles();
        } catch (err) {
          showToast(`删除失败: ${err.message}`, 'error');
        }
      }
    });

    fileListContainer.appendChild(item);
  }
}

async function loadFiles(isSilent = false) {
  try {
    const res = await api.getFiles();
    currentFiles = res.files || [];
    if (res.serverTime) {
      serverTimeOffset = res.serverTime - Date.now();
    }
    renderFileList();
  } catch (err) {
    if (!isSilent) showToast(`获取文件失败: ${err.message}`, 'error');
  }
}

btnRefreshFiles.addEventListener('click', () => {
  loadFiles();
  showToast('已刷新', 'info');
});

function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    const countSpans = document.querySelectorAll('.expire-countdown');
    countSpans.forEach((span) => {
      const expires = parseInt(span.getAttribute('data-expires'), 10);
      if (expires) {
        span.textContent = formatRemainingTime(expires);
      }
    });
  }, 10000);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// 6. 信任设备管理
btnDevices.addEventListener('click', async () => {
  devicesModal.style.display = 'flex';
  await loadDevicesList();
});

btnCloseModal.addEventListener('click', () => {
  devicesModal.style.display = 'none';
});

devicesModal.addEventListener('click', (e) => {
  if (e.target === devicesModal) {
    devicesModal.style.display = 'none';
  }
});

async function loadDevicesList() {
  devicesList.innerHTML = '<div style="text-align: center; padding: 1.5rem; color: var(--text-muted);">加载中...</div>';
  try {
    const res = await api.getDevices();
    const devices = res.devices || [];

    if (devices.length === 0) {
      devicesList.innerHTML = '<div class="empty-state">无设备</div>';
      return;
    }

    devicesList.innerHTML = '';
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
              showToast('已踢出', 'success');
              loadDevicesList();
            } catch (err) {
              showToast(`操作失败: ${err.message}`, 'error');
            }
          }
        });
      }

      devicesList.appendChild(item);
    }
  } catch (err) {
    devicesList.innerHTML = `<div class="empty-state" style="color: var(--danger-color);">加载失败: ${err.message}</div>`;
  }
}

btnRevokeOthers.addEventListener('click', async () => {
  if (confirm('确定踢出除当前设备外的所有其他设备？')) {
    try {
      await api.revokeOthers();
      showToast('已踢出其他设备', 'success');
      loadDevicesList();
    } catch (err) {
      showToast(`操作失败: ${err.message}`, 'error');
    }
  }
});

// 7. 初始化文件上传与拖拽监听
initUploader({
  onUploadSuccess: () => {
    loadFiles();
  },
  showToast,
});

// 8. 应用程序启动入口
function initApp() {
  if (authState.isLoggedIn()) {
    hideLockScreen();
  } else {
    showLockScreen();
  }
}

initApp();
