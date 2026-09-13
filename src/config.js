import path from 'node:path';
import fs from 'node:fs';

const PORT = parseInt(process.env.PORT || '8080', 10);
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'storage.db');
const FILE_EXPIRE_HOURS = parseInt(process.env.FILE_EXPIRE_HOURS || '24', 10);
const SESSION_EXPIRE_DAYS = parseInt(process.env.SESSION_EXPIRE_DAYS || '14', 10);
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '5120', 10); // 5GB 默认
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// 确保数据与上传目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export const config = {
  PORT,
  APP_PASSWORD,
  DATA_DIR,
  UPLOAD_DIR,
  DB_PATH,
  FILE_EXPIRE_HOURS,
  SESSION_EXPIRE_DAYS,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
};
