import { api } from './api.js';

export function initUploader({ onUploadSuccess, onUploadError, showToast }) {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const progressContainer = document.getElementById('upload-progress');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressFilename = document.getElementById('upload-filename');
  const progressPercentage = document.getElementById('upload-percentage');

  // 点击选择文件
  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      handleFilesUpload(files);
    }
    fileInput.value = '';
  });

  // 拖拽高亮处理
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      handleFilesUpload(files);
    }
  });

  // 全局剪贴板粘贴监听
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData ? e.clipboardData.items : [];
    const filesToUpload = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          let filename = file.name;
          if (!filename || filename === 'image.png' || filename === 'blob') {
            const nowStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const ext = file.type.split('/')[1] || 'png';
            filename = `clip_${nowStr}.${ext}`;
          }
          const renamedFile = new File([file], filename, { type: file.type });
          filesToUpload.push(renamedFile);
        }
      }
    }

    if (filesToUpload.length > 0) {
      e.preventDefault();
      showToast(`正在上传剪贴板文件...`, 'info');
      handleFilesUpload(filesToUpload);
    }
  });

  // 执行上传
  async function handleFilesUpload(files) {
    if (!files || files.length === 0) return;

    progressContainer.style.display = 'block';
    progressPercentage.textContent = '0%';
    progressBarFill.style.width = '0%';
    progressFilename.textContent = files.length === 1 
      ? files[0].name 
      : `${files.length} 个文件`;

    try {
      const res = await api.uploadFiles(files, (percent, loaded, total) => {
        progressPercentage.textContent = `${percent}%`;
        progressBarFill.style.width = `${percent}%`;
        
        const loadedMb = (loaded / (1024 * 1024)).toFixed(1);
        const totalMb = (total / (1024 * 1024)).toFixed(1);
        progressFilename.textContent = files.length === 1 
          ? `${files[0].name} (${loadedMb}/${totalMb}MB)` 
          : `${files.length} 个文件 (${loadedMb}/${totalMb}MB)`;
      });

      showToast('上传完成', 'success');
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 1000);

      if (onUploadSuccess) onUploadSuccess(res);
    } catch (err) {
      showToast(`上传失败: ${err.message}`, 'error');
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 2000);

      if (onUploadError) onUploadError(err);
    }
  }
}
