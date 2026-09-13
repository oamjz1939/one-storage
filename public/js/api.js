/**
 * API 请求封装与 Token 管理
 */
const TOKEN_KEY = 'one_storage_token';

export const authState = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  },
  setToken(token) {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  },
  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },
  isLoggedIn() {
    return Boolean(this.getToken());
  },
};

let onUnauthorizedCallback = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorizedCallback = handler;
}

async function request(url, options = {}) {
  const token = authState.getToken();
  const headers = {
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  try {
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      authState.clearToken();
      if (onUnauthorizedCallback) {
        onUnauthorizedCallback();
      }
      throw new Error('未授权或登录已过期');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
  } catch (err) {
    throw err;
  }
}

export const api = {
  async login(password) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: { password },
    });
    if (data.token) {
      authState.setToken(data.token);
    }
    return data;
  },

  async getMe() {
    return request('/api/auth/me');
  },

  async getDevices() {
    return request('/api/devices');
  },

  async revokeDevice(id) {
    return request(`/api/devices/${id}/revoke`, { method: 'POST' });
  },

  async revokeOthers() {
    return request('/api/devices/revoke-others', { method: 'POST' });
  },

  async logout() {
    try {
      await request('/api/auth/logout', { method: 'POST' });
    } finally {
      authState.clearToken();
    }
  },

  async getNotepad() {
    return request('/api/notepad');
  },

  async saveNotepad(content) {
    return request('/api/notepad', {
      method: 'POST',
      body: { content },
    });
  },

  async getFiles() {
    return request('/api/files');
  },

  async changePassword(oldPassword, newPassword) {
    return request('/api/auth/change-password', {
      method: 'POST',
      body: { oldPassword, newPassword },
    });
  },

  async deleteFile(id) {
    return request(`/api/files/${id}`, { method: 'DELETE' });
  },

  async deleteAllFiles() {
    return request('/api/files', { method: 'DELETE' });
  },

  uploadFiles(files, onProgress) {
    let xhr;
    const promise = new Promise((resolve, reject) => {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file, file.name);
      }

      xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');

      const token = authState.getToken();
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent, e.loaded, e.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 401) {
          authState.clearToken();
          if (onUnauthorizedCallback) onUnauthorizedCallback();
          return reject(new Error('登录已过期'));
        }
        try {
          const res = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(res);
          } else {
            reject(new Error(res.error || '上传失败'));
          }
        } catch {
          reject(new Error('上传响应异常'));
        }
      };

      xhr.onerror = () => reject(new Error('网络请求异常'));
      xhr.onabort = () => {
        const err = new Error('上传已取消');
        err.name = 'AbortError';
        reject(err);
      };
      xhr.send(formData);
    });

    promise.abort = () => {
      if (xhr) {
        xhr.abort();
      }
    };

    return promise;
  },
};
