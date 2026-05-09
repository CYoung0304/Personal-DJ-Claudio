const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'claudio.db'));

// Enable WAL mode for better concurrent read performance
db.exec('PRAGMA journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    song_name TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    album_cover TEXT,
    played_at TEXT DEFAULT (datetime('now', 'localtime')),
    context TEXT,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS prefs (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time_slot TEXT NOT NULL,
    mood TEXT,
    genre_hint TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// Prepared statements
const insertPlay = db.prepare(`
  INSERT INTO plays (song_id, song_name, artist, album, album_cover, context, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectRecentPlays = db.prepare(`
  SELECT * FROM plays ORDER BY played_at DESC LIMIT ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (role, content) VALUES (?, ?)
`);

const selectRecentMessages = db.prepare(`
  SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?
`);

const upsertPref = db.prepare(`
  INSERT INTO prefs (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const selectPref = db.prepare(`SELECT value FROM prefs WHERE key = ?`);

const insertPlan = db.prepare(`
  INSERT INTO plan (time_slot, mood, genre_hint) VALUES (?, ?, ?)
`);

const selectTodayPlan = db.prepare(`
  SELECT * FROM plan WHERE date(created_at) = date('now', 'localtime') ORDER BY id
`);

const clearTodayPlan = db.prepare(`
  DELETE FROM plan WHERE date(created_at) = date('now', 'localtime')
`);

// Public API
function logPlay(song, context = '', reason = '') {
  return insertPlay.run(song.id, song.name, song.artist || '', song.album || '', song.albumCover || '', context, reason);
}

function getRecentPlays(limit = 20) {
  return selectRecentPlays.all(limit);
}

function saveMessage(role, content) {
  return insertMessage.run(role, content);
}

function getRecentMessages(limit = 20) {
  return selectRecentMessages.all(limit);
}

function setPref(key, value) {
  return upsertPref.run(key, JSON.stringify(value));
}

function getPref(key, defaultValue = null) {
  const row = selectPref.get(key);
  if (!row) return defaultValue;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function saveDailyPlan(slots) {
  clearTodayPlan.run();
  for (const slot of slots) {
    insertPlan.run(slot.time_slot, slot.mood || '', slot.genre_hint || '');
  }
}

function getDailyPlan() {
  return selectTodayPlan.all();
}

function close() {
  db.close();
}

module.exports = {
  db,
  logPlay,
  getRecentPlays,
  saveMessage,
  getRecentMessages,
  setPref,
  getPref,
  saveDailyPlan,
  getDailyPlan,
  close,
};
