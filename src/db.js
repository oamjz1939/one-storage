import Database from 'better-sqlite3';
import { config } from './config.js';

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    ip TEXT,
    user_agent TEXT,
    device_name TEXT,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    is_revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notepad (
    id INTEGER PRIMARY KEY,
    content TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
`);

// 初始化 notepad 记录（如果不存在）
const initNotepad = db.prepare(`
  INSERT OR IGNORE INTO notepad (id, content, updated_at) VALUES (1, '', ?)
`);
initNotepad.run(Date.now());

// Sessions 相关操作
export const sessionDb = {
  create: db.prepare(`
    INSERT INTO sessions (id, token, ip, user_agent, device_name, created_at, last_active_at, is_revoked)
    VALUES (@id, @token, @ip, @userAgent, @deviceName, @createdAt, @lastActiveAt, 0)
  `),

  findByToken: db.prepare(`
    SELECT * FROM sessions WHERE token = ? AND is_revoked = 0
  `),

  findById: db.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `),

  touch: db.prepare(`
    UPDATE sessions SET last_active_at = ? WHERE token = ? AND is_revoked = 0
  `),

  listActive: db.prepare(`
    SELECT id, token, ip, device_name, created_at, last_active_at 
    FROM sessions 
    WHERE is_revoked = 0 AND created_at >= ?
    ORDER BY last_active_at DESC
  `),

  revokeById: db.prepare(`
    UPDATE sessions SET is_revoked = 1 WHERE id = ?
  `),

  revokeOthers: db.prepare(`
    UPDATE sessions SET is_revoked = 1 WHERE token != ?
  `),

  cleanExpired: db.prepare(`
    DELETE FROM sessions WHERE created_at < ? OR (is_revoked = 1 AND last_active_at < ?)
  `),
};

// Notepad 相关操作
export const notepadDb = {
  get: db.prepare(`
    SELECT content, updated_at FROM notepad WHERE id = 1
  `),

  save: db.prepare(`
    UPDATE notepad SET content = @content, updated_at = @updatedAt WHERE id = 1
  `),
};

// Files 相关操作
export const fileDb = {
  create: db.prepare(`
    INSERT INTO files (id, original_name, stored_name, file_size, mime_type, created_at, expires_at)
    VALUES (@id, @originalName, @storedName, @fileSize, @mimeType, @createdAt, @expiresAt)
  `),

  listActive: db.prepare(`
    SELECT id, original_name, file_size, mime_type, created_at, expires_at 
    FROM files 
    WHERE expires_at > ?
    ORDER BY created_at DESC
  `),

  findById: db.prepare(`
    SELECT * FROM files WHERE id = ?
  `),

  deleteById: db.prepare(`
    DELETE FROM files WHERE id = ?
  `),

  findExpired: db.prepare(`
    SELECT * FROM files WHERE expires_at <= ?
  `),

  findByStoredName: db.prepare(`
    SELECT id FROM files WHERE stored_name = ?
  `),

  listAllStoredNames: db.prepare(`
    SELECT stored_name FROM files
  `),
};

export default db;
