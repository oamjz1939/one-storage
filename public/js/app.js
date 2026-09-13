import { api, authState, setUnauthorizedHandler } from './api.js';
import { wsClient } from './ws.js';
import { initUploader } from './uploader.js';
import { NotepadManager } from './notepad.js';
import { DevicesModalManager } from './devices.js';
import { FilesManager } from './files.js';

// DOM 元素引用
const lockScreen = document.getElementById('lock-screen');
const lockCard = document.getElementById('lock-card');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnLogout = document.getElementById('btn-logout');

// 1. 全局 Toast 提示工具 (Material 3 Snackbar)
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

// 2. 模块初始化
const notepadManager = new NotepadManager({
  textarea: document.getElementById('notepad-input'),
  charCountEl: document.getElementById('notepad-char-count'),
  syncStatusEl: document.getElementById('notepad-sync-status'),
  btnCopy: document.getElementById('btn-copy-notepad'),
  btnClear: document.getElementById('btn-clear-notepad'),
  showToast,
});

const devicesManager = new DevicesModalManager({
  modalEl: document.getElementById('devices-modal'),
  listEl: document.getElementById('devices-list'),
  btnOpen: document.getElementById('btn-devices'),
  btnClose: document.getElementById('btn-close-modal'),
  btnRevokeOthers: document.getElementById('btn-revoke-others'),
  showToast,
});

const filesManager = new FilesManager({
  listContainer: document.getElementById('file-list'),
  emptyStateEl: document.getElementById('empty-state'),
  countEl: document.getElementById('file-count'),
  btnRefresh: document.getElementById('btn-refresh-files'),
  showToast,
});

// 3. 鉴权与锁屏处理
function showLockScreen() {
  lockScreen.style.display = 'flex';
  wsClient.disconnect();
  filesManager.stopCountdown();
  passwordInput.value = '';
  setTimeout(() => passwordInput.focus(), 100);
}

function hideLockScreen() {
  lockScreen.style.display = 'none';
  wsClient.connect();
  notepadManager.loadInitial();
  filesManager.loadFiles();
  filesManager.startCountdown();
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

// 锁定
btnLogout.addEventListener('click', async () => {
  if (confirm('确定锁定当前设备？')) {
    await api.logout();
    showToast('已锁定', 'info');
    showLockScreen();
  }
});

// 4. WebSocket 连接与网络在线/离线状态
function updateOnlineStatus(isOnline, text = null) {
  if (isOnline) {
    statusDot.className = 'status-dot online';
    statusText.textContent = text || '在线';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = text || '离线';
  }
}

wsClient.on('status', ({ connected }) => {
  if (connected) {
    updateOnlineStatus(true, '在线');
  } else {
    updateOnlineStatus(false, navigator.onLine ? '连接中' : '网络断开');
  }
});

wsClient.on('force_logout', (data) => {
  showToast(data.reason || '设备已被下线', 'error');
  authState.clearToken();
  showLockScreen();
});

window.addEventListener('online', () => {
  updateOnlineStatus(true, '已连网');
  if (authState.isLoggedIn()) {
    wsClient.connect();
    notepadManager.syncLocalDraftToServer();
  }
});

window.addEventListener('offline', () => {
  updateOnlineStatus(false, '网络断开');
  showToast('网络已断开，编辑内容将保存在本地', 'warning');
});

// 5. 初始化上传组件
initUploader({
  onUploadSuccess: () => {
    filesManager.loadFiles();
  },
  showToast,
});

// 6. 应用程序启动入口
function initApp() {
  if (authState.isLoggedIn()) {
    hideLockScreen();
  } else {
    showLockScreen();
  }
}

initApp();
