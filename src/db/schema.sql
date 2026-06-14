-- Mood state per chat
CREATE TABLE IF NOT EXISTS mood (
  chat_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Activity counter per chat
CREATE TABLE IF NOT EXISTS activity (
  chat_id INTEGER PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);

-- Memory events per chat (capped at 80)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Topics per chat
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_ts INTEGER NOT NULL
);

-- Jokes per chat
CREATE TABLE IF NOT EXISTS jokes (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  joke_references INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Nicknames per chat
CREATE TABLE IF NOT EXISTS nicknames (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);

-- Summary per chat
CREATE TABLE IF NOT EXISTS summaries (
  chat_id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Settings (global, not per-chat)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Analytics per chat
CREATE TABLE IF NOT EXISTS analytics (
  chat_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
