import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

export interface Reaction {
  message_id: string;
  message_chat_jid: string;
  reactor_jid: string;
  reactor_name?: string;
  emoji: string;
  timestamp: string;
}

export interface WorkItem {
  id: number;
  group_folder: string;
  title: string;
  description: string | null;
  status: 'queued' | 'in_progress' | 'done' | 'blocked' | 'deferred';
  priority: number;
  source: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  reasoning: string | null;
  outcome: string | null;
  blocked_reason: string | null;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      message_chat_jid TEXT NOT NULL,
      reactor_jid TEXT NOT NULL,
      reactor_name TEXT,
      emoji TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (message_id, message_chat_jid, reactor_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions(reactor_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions(emoji);
    CREATE INDEX IF NOT EXISTS idx_reactions_timestamp ON reactions(timestamp);

    CREATE TABLE IF NOT EXISTS agent_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER DEFAULT 50,
      source TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      started_at INTEGER,
      completed_at INTEGER,
      reasoning TEXT,
      outcome TEXT,
      blocked_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_folder ON agent_work_items(group_folder);
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON agent_work_items(status);

    CREATE TABLE IF NOT EXISTS token_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_cost_usd REAL,
      model_usage TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_token_logs_chat ON token_logs(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_logs_group ON token_logs(group_folder, timestamp);

    CREATE TABLE IF NOT EXISTS ignored_groups (
      jid TEXT PRIMARY KEY,
      reason TEXT,
      ignored_at DATETIME DEFAULT (datetime('now'))
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add thread_message_id column if it doesn't exist (migration for thread reply support)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_message_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add model column if it doesn't exist (migration for per-group model override)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for main group flag)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add wip_limit column if it doesn't exist (migration for initiative loop)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN wip_limit INTEGER DEFAULT 2`,
    );
  } catch {
    /* column already exists */
  }

  // Add token usage columns to task_run_logs if they don't exist
  try {
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN input_tokens INTEGER`);
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN output_tokens INTEGER`);
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN total_cost_usd REAL`);
  } catch {
    /* columns already exist */
  }

  // Add model_usage column to token_logs if it doesn't exist
  try {
    database.exec(`ALTER TABLE token_logs ADD COLUMN model_usage TEXT`);
  } catch {
    /* column already exists */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Pre-populate ignored_groups with known archived/deleted groups
  const archivedGroups = [
    {
      jid: '120363426214845360@g.us',
      reason: 'archived — #vault (consolidated into #system)',
    },
    {
      jid: '120363424773829181@g.us',
      reason: 'archived — #engine (consolidated into #system)',
    },
    {
      jid: '120363407937678572@g.us',
      reason: 'archived — #foundation (consolidated into #system)',
    },
    {
      jid: '120363407229437449@g.us',
      reason: 'archived — #daily-briefing (decommissioned)',
    },
  ];
  const insertIgnored = database.prepare(
    `INSERT OR IGNORE INTO ignored_groups (jid, reason) VALUES (?, ?)`,
  );
  for (const { jid, reason } of archivedGroups) {
    insertIgnored.run(jid, reason);
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Use journal mode from env, defaulting to DELETE.
  // DELETE avoids -wal/-shm files that aren't reliably visible in Docker bind mounts.
  // WAL can be used when the DB isn't accessed across mount boundaries.
  const journalMode = process.env.SQLITE_JOURNAL_MODE || 'DELETE';
  db.pragma(`journal_mode = ${journalMode}`);

  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get the set of JIDs that should be excluded from available_groups.json.
 * These are archived or deleted groups that clutter the list.
 */
export function getIgnoredGroupJids(): Set<string> {
  const rows = db.prepare(`SELECT jid FROM ignored_groups`).all() as {
    jid: string;
  }[];
  return new Set(rows.map((r) => r.jid));
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_message_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_message_id || null,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  thread_message_id?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_message_id || null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             thread_message_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             thread_message_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getMessageFromMe(
  messageId: string,
  chatJid: string,
): { fromMe: boolean; sender: string | null } {
  const row = db
    .prepare(
      `SELECT is_from_me, sender FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(messageId, chatJid) as
    | { is_from_me: number | null; sender: string | null }
    | undefined;
  return {
    fromMe: row?.is_from_me === 1,
    sender: row?.sender ?? null,
  };
}

export function getLatestMessage(
  chatJid: string,
): { id: string; fromMe: boolean; sender: string | null } | undefined {
  const row = db
    .prepare(
      `SELECT id, is_from_me, sender FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as
    | { id: string; is_from_me: number | null; sender: string | null }
    | undefined;
  if (!row) return undefined;
  return { id: row.id, fromMe: row.is_from_me === 1, sender: row.sender };
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function storeReaction(reaction: Reaction): void {
  if (!reaction.emoji) {
    db.prepare(
      `DELETE FROM reactions WHERE message_id = ? AND message_chat_jid = ? AND reactor_jid = ?`,
    ).run(reaction.message_id, reaction.message_chat_jid, reaction.reactor_jid);
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO reactions (message_id, message_chat_jid, reactor_jid, reactor_name, emoji, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    reaction.message_id,
    reaction.message_chat_jid,
    reaction.reactor_jid,
    reaction.reactor_name || null,
    reaction.emoji,
    reaction.timestamp,
  );
}

export function getReactionsForMessage(
  messageId: string,
  chatJid: string,
): Reaction[] {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE message_id = ? AND message_chat_jid = ? ORDER BY timestamp`,
    )
    .all(messageId, chatJid) as Reaction[];
}

export function getMessagesByReaction(
  reactorJid: string,
  emoji: string,
  chatJid?: string,
): Array<
  Reaction & { content: string; sender_name: string; message_timestamp: string }
> {
  const sql = chatJid
    ? `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ? AND r.message_chat_jid = ?
      ORDER BY r.timestamp DESC
    `
    : `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ?
      ORDER BY r.timestamp DESC
    `;

  type Result = Reaction & {
    content: string;
    sender_name: string;
    message_timestamp: string;
  };
  return chatJid
    ? (db.prepare(sql).all(reactorJid, emoji, chatJid) as Result[])
    : (db.prepare(sql).all(reactorJid, emoji) as Result[]);
}

export function getReactionsByUser(
  reactorJid: string,
  limit: number = 50,
): Reaction[] {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE reactor_jid = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(reactorJid, limit) as Reaction[];
}

export function getReactionStats(chatJid?: string): Array<{
  emoji: string;
  count: number;
}> {
  const sql = chatJid
    ? `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      WHERE message_chat_jid = ?
      GROUP BY emoji
      ORDER BY count DESC
    `
    : `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      GROUP BY emoji
      ORDER BY count DESC
    `;

  type Result = { emoji: string; count: number };
  return chatJid
    ? (db.prepare(sql).all(chatJid) as Result[])
    : (db.prepare(sql).all() as Result[]);
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, input_tokens, output_tokens, total_cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
    log.input_tokens ?? null,
    log.output_tokens ?? null,
    log.total_cost_usd ?? null,
  );
}

export function logTokenUsage(log: {
  chat_jid: string;
  group_folder: string;
  timestamp: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_cost_usd: number | null;
  modelUsage?: Record<string, unknown>;
}): void {
  db.prepare(
    `
    INSERT INTO token_logs (chat_jid, group_folder, timestamp, input_tokens, output_tokens, total_cost_usd, model_usage)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.chat_jid,
    log.group_folder,
    log.timestamp,
    log.input_tokens,
    log.output_tokens,
    log.total_cost_usd,
    log.modelUsage != null ? JSON.stringify(log.modelUsage) : null,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        model: string | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    model: row.model || undefined,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, model, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.model || null,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    model: string | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      model: row.model || undefined,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Reaction summary for agent self-review ---

export interface ReactionSummaryEntry {
  emoji: string;
  count: number;
  last_seen: string;
  sample_messages: string[]; // up to 3 message content snippets (first 120 chars)
}

export interface ThreadReply {
  sender_name: string | null;
  content: string;
  timestamp: string;
}

export interface ReactionOnMessage {
  emoji: string;
  reactor_name: string | null;
  timestamp: string;
  message_snippet: string;
  message_id: string;
  thread_replies: ThreadReply[]; // replies in the same thread, providing context on the reaction
}

export function getReactionSummaryForGroup(
  chatJid: string,
  days: number = 30,
  limit: number = 20,
): { summary: ReactionSummaryEntry[]; recent: ReactionOnMessage[] } {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Aggregate by emoji
  const summaryRows = db
    .prepare(
      `SELECT r.emoji,
              COUNT(*) as count,
              MAX(r.timestamp) as last_seen
       FROM reactions r
       JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
       WHERE m.chat_jid = ? AND m.is_bot_message = 1 AND r.timestamp > ?
       GROUP BY r.emoji
       ORDER BY count DESC`,
    )
    .all(chatJid, since) as Array<{
    emoji: string;
    count: number;
    last_seen: string;
  }>;

  // Sample messages per emoji (up to 3 per emoji)
  const summary: ReactionSummaryEntry[] = summaryRows.map((row) => {
    const samples = db
      .prepare(
        `SELECT SUBSTR(m.content, 1, 120) as snippet
         FROM reactions r
         JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
         WHERE m.chat_jid = ? AND m.is_bot_message = 1
           AND r.emoji = ? AND r.timestamp > ?
         ORDER BY r.timestamp DESC
         LIMIT 3`,
      )
      .all(chatJid, row.emoji, since) as Array<{ snippet: string }>;
    return {
      emoji: row.emoji,
      count: row.count,
      last_seen: row.last_seen,
      sample_messages: samples.map((s) => s.snippet),
    };
  });

  // Most recent individual reactions (for the detailed view), including message_id for thread lookup
  const recentRows = db
    .prepare(
      `SELECT r.emoji, r.reactor_name, r.timestamp,
              SUBSTR(m.content, 1, 120) as message_snippet,
              m.id as message_id
       FROM reactions r
       JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
       WHERE m.chat_jid = ? AND m.is_bot_message = 1 AND r.timestamp > ?
       ORDER BY r.timestamp DESC
       LIMIT ?`,
    )
    .all(chatJid, since, limit) as Array<
    Omit<ReactionOnMessage, 'thread_replies'>
  >;

  // Fetch thread replies for each reacted message (non-bot replies where thread_message_id = reacted message id)
  const threadRepliesStmt = db.prepare(
    `SELECT sender_name, SUBSTR(content, 1, 240) as content, timestamp
     FROM messages
     WHERE chat_jid = ? AND thread_message_id = ? AND is_bot_message = 0
     ORDER BY timestamp ASC`,
  );

  const recent: ReactionOnMessage[] = recentRows.map((row) => ({
    ...row,
    thread_replies: threadRepliesStmt.all(
      chatJid,
      row.message_id,
    ) as ThreadReply[],
  }));

  return { summary, recent };
}

// --- Work item accessors ---

export function createWorkItem(
  item: Omit<WorkItem, 'id' | 'created_at'>,
): number {
  const result = db
    .prepare(
      `INSERT INTO agent_work_items
        (group_folder, title, description, status, priority, source, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.group_folder,
      item.title,
      item.description ?? null,
      item.status,
      item.priority ?? 50,
      item.source ?? null,
      item.reasoning ?? null,
    );
  return result.lastInsertRowid as number;
}

export function getWorkItem(id: number): WorkItem | undefined {
  return db.prepare('SELECT * FROM agent_work_items WHERE id = ?').get(id) as
    | WorkItem
    | undefined;
}

export function listWorkItems(
  groupFolder: string | null,
  statusFilter?: string[],
): WorkItem[] {
  let sql = 'SELECT * FROM agent_work_items';
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (groupFolder) {
    conditions.push('group_folder = ?');
    params.push(groupFolder);
  }
  if (statusFilter && statusFilter.length > 0) {
    const placeholders = statusFilter.map(() => '?').join(', ');
    conditions.push(`status IN (${placeholders})`);
    params.push(...statusFilter);
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }
  sql += ' ORDER BY priority DESC, created_at ASC';

  return db.prepare(sql).all(...params) as WorkItem[];
}

export function getWipCount(groupFolder: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM agent_work_items
       WHERE group_folder = ? AND status = 'in_progress'`,
    )
    .get(groupFolder) as { count: number };
  return row.count;
}

export function getWipLimit(groupFolder: string): number {
  const row = db
    .prepare(`SELECT wip_limit FROM registered_groups WHERE folder = ?`)
    .get(groupFolder) as { wip_limit: number | null } | undefined;
  return row?.wip_limit ?? 2;
}

export function updateWorkItem(
  id: number,
  updates: Partial<
    Pick<
      WorkItem,
      | 'status'
      | 'title'
      | 'description'
      | 'priority'
      | 'reasoning'
      | 'outcome'
      | 'blocked_reason'
    >
  >,
  sourceGroup: string,
  isMain: boolean,
): { success: boolean; error?: string } {
  const item = getWorkItem(id);
  if (!item) {
    return { success: false, error: `Work item ${id} not found` };
  }
  if (!isMain && item.group_folder !== sourceGroup) {
    return {
      success: false,
      error: `Unauthorized: item ${id} belongs to ${item.group_folder}`,
    };
  }

  // WIP limit enforcement: block transition to in_progress if at limit
  if (updates.status === 'in_progress' && item.status !== 'in_progress') {
    const wipCount = getWipCount(item.group_folder);
    const wipLimit = getWipLimit(item.group_folder);
    if (wipCount >= wipLimit) {
      return {
        success: false,
        error: `WIP limit reached (${wipCount}/${wipLimit}). Complete or defer an in-progress item first.`,
      };
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'in_progress') {
      fields.push('started_at = ?');
      values.push(Math.floor(Date.now() / 1000));
    }
    if (updates.status === 'done' || updates.status === 'deferred') {
      fields.push('completed_at = ?');
      values.push(Math.floor(Date.now() / 1000));
    }
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.reasoning !== undefined) {
    fields.push('reasoning = ?');
    values.push(updates.reasoning);
  }
  if (updates.outcome !== undefined) {
    fields.push('outcome = ?');
    values.push(updates.outcome);
  }
  if (updates.blocked_reason !== undefined) {
    fields.push('blocked_reason = ?');
    values.push(updates.blocked_reason);
  }

  if (fields.length === 0) return { success: true };

  values.push(id);
  db.prepare(
    `UPDATE agent_work_items SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
  return { success: true };
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
