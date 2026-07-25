// SQLite Database Manager — Real-time synced with WAL mode
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'tickets.db');

let db = null;

export function initDatabase() {
  db = new Database(DB_PATH);

  // Enable WAL mode for crash-safe writes + better concurrent performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  createTables();
  console.log('[DB] SQLite database initialized at', DB_PATH);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      account_level INTEGER DEFAULT 0,
      login_email TEXT,
      login_password TEXT,
      platform TEXT NOT NULL CHECK(platform IN ('XBL', 'PSN')),
      platform_login_email TEXT,
      platform_login_password TEXT,
      platform_email TEXT,
      platform_dob TEXT,
      backup_email TEXT,
      date_linked TEXT,
      ubisoft_token TEXT,
      token_expiry TEXT,
      session_id TEXT,
      profile_id TEXT,
      user_id TEXT,
      auth_data_json TEXT,
      login_status TEXT DEFAULT 'pending' CHECK(login_status IN ('pending', 'authenticated', 'manual_login_required', 'failed')),
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      case_number TEXT,
      case_id_full TEXT,
      status TEXT DEFAULT 'Open' CHECK(status IN ('Open', 'Awaiting Reply', 'Awaiting Response', 'Completed', 'Manual Login Required')),
      platform TEXT NOT NULL CHECK(platform IN ('XBL', 'PSN')),
      contact_email TEXT,
      lost_email TEXT,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      completed_at TEXT,
      week_number INTEGER,
      year INTEGER,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      comment_id TEXT,
      body TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at_remote TEXT,
      source TEXT DEFAULT 'CaseComment',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS failed_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      csv_line INTEGER,
      raw_data TEXT NOT NULL,
      platform TEXT,
      failure_reason TEXT,
      username TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_account ON tickets(account_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_platform ON tickets(platform);
    CREATE INDEX IF NOT EXISTS idx_tickets_opened ON tickets(opened_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_week ON tickets(week_number, year);
    CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(login_status);
    CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);
  `);

  // Insert default settings if they don't exist
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('proxy_us', 'uorder40522_country-US:KD1syXKaSXTQJGDn@budget.legionproxy.io:1337');
  insertSetting.run('proxy_global', 'uorder40522:KD1syXKaSXTQJGDn@budget.legionproxy.io:1337');
  insertSetting.run('captcha_api_key', '3929d3ab5b72747c0ffb4caccf17bddf');
  insertSetting.run('poll_interval_seconds', '45');
  insertSetting.run('token_refresh_minutes', '50');
  insertSetting.run('ai_api_key', 'sk-dummy-key');
  insertSetting.run('ai_model', 'deepseek/deepseek-chat-v3-0324');
  insertSetting.run('camofox_path', 'camofox');
  insertSetting.run('concurrency_threads', '3');
}

// ─── Account Operations ─────────────────────────────────────────────────────

export function insertAccount(account) {
  const stmt = getDb().prepare(`
    INSERT INTO accounts (username, account_level, login_email, login_password, platform,
      platform_login_email, platform_login_password, platform_email, platform_dob,
      backup_email, date_linked, login_status)
    VALUES (@username, @account_level, @login_email, @login_password, @platform,
      @platform_login_email, @platform_login_password, @platform_email, @platform_dob,
      @backup_email, @date_linked, @login_status)
  `);
  return stmt.run(account);
}

export function updateAccountAuth(id, authData) {
  const stmt = getDb().prepare(`
    UPDATE accounts SET
      ubisoft_token = @ubisoft_token,
      token_expiry = @token_expiry,
      session_id = @session_id,
      profile_id = @profile_id,
      user_id = @user_id,
      auth_data_json = @auth_data_json,
      login_status = 'authenticated',
      updated_at = datetime('now')
    WHERE id = @id
  `);
  return stmt.run({ id, ...authData });
}

export function updateAccountLoginStatus(id, status) {
  const stmt = getDb().prepare(`
    UPDATE accounts SET login_status = ?, updated_at = datetime('now') WHERE id = ?
  `);
  return stmt.run(status, id);
}

export function updateAccountNotes(id, notes) {
  const stmt = getDb().prepare(`
    UPDATE accounts SET notes = ?, updated_at = datetime('now') WHERE id = ?
  `);
  return stmt.run(notes, id);
}

export function updateAccountManualAuth(id, authDataJson) {
  const authData = JSON.parse(authDataJson);
  const stmt = getDb().prepare(`
    UPDATE accounts SET
      ubisoft_token = ?,
      token_expiry = ?,
      session_id = ?,
      profile_id = ?,
      user_id = ?,
      auth_data_json = ?,
      login_status = 'authenticated',
      updated_at = datetime('now')
    WHERE id = ?
  `);
  return stmt.run(
    authData.ticket || null,
    authData.expiration || null,
    authData.sessionId || null,
    authData.profileId || null,
    authData.userId || null,
    authDataJson,
    id
  );
}

export function getAllAccounts() {
  return getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
}

export function getAccountById(id) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function getAccountsByStatus(status) {
  return getDb().prepare('SELECT * FROM accounts WHERE login_status = ? ORDER BY created_at DESC').all(status);
}

export function getAuthenticatedAccounts() {
  return getDb().prepare("SELECT * FROM accounts WHERE login_status = 'authenticated' ORDER BY created_at DESC").all();
}

export function deleteAccount(id) {
  return getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ─── Ticket Operations ──────────────────────────────────────────────────────

export function insertTicket(ticket) {
  // Calculate week number (Sunday start)
  const openDate = new Date(ticket.opened_at || new Date().toISOString());
  const dayOfYear = Math.floor((openDate - new Date(openDate.getFullYear(), 0, 1)) / 86400000);
  const weekNumber = Math.ceil((dayOfYear + new Date(openDate.getFullYear(), 0, 1).getDay() + 1) / 7);

  const stmt = getDb().prepare(`
    INSERT INTO tickets (account_id, case_number, case_id_full, status, platform,
      contact_email, lost_email, week_number, year, notes)
    VALUES (@account_id, @case_number, @case_id_full, @status, @platform,
      @contact_email, @lost_email, @week_number, @year, @notes)
  `);
  return stmt.run({
    ...ticket,
    week_number: weekNumber,
    year: openDate.getFullYear(),
    notes: ticket.notes || '',
  });
}

export function updateTicketStatus(id, status) {
  if (status === 'Completed') {
    const stmt = getDb().prepare(`
      UPDATE tickets SET status = ?, completed_at = datetime('now'), closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `);
    return stmt.run(status, id);
  }
  const stmt = getDb().prepare(`
    UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?
  `);
  return stmt.run(status, id);
}

export function updateTicketNotes(id, notes) {
  const stmt = getDb().prepare(`
    UPDATE tickets SET notes = ?, updated_at = datetime('now') WHERE id = ?
  `);
  return stmt.run(notes, id);
}

export function getTicketById(id) {
  return getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

export function getTicketByAccountId(accountId) {
  return getDb().prepare("SELECT * FROM tickets WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").get(accountId);
}

export function getAllTickets(filters = {}) {
  let query = `
    SELECT t.*, a.username, a.account_level, a.login_email, a.platform_login_email,
      a.platform_email, a.backup_email, a.date_linked, a.login_status
    FROM tickets t
    JOIN accounts a ON t.account_id = a.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.platform) {
    query += ' AND t.platform = ?';
    params.push(filters.platform);
  }
  if (filters.status) {
    query += ' AND t.status = ?';
    params.push(filters.status);
  }
  if (filters.date) {
    query += " AND date(t.opened_at) = date(?)";
    params.push(filters.date);
  }

  query += ' ORDER BY t.created_at DESC';
  return getDb().prepare(query).all(...params);
}

export function deleteTicket(id) {
  return getDb().prepare('DELETE FROM tickets WHERE id = ?').run(id);
}

export function getWeeklyStats(year, month) {
  let query = `
    SELECT week_number, year, platform, COUNT(*) as count
    FROM tickets
    WHERE status = 'Completed'
  `;
  const params = [];

  if (year) {
    query += ' AND year = ?';
    params.push(year);
  }
  if (month) {
    query += " AND CAST(strftime('%m', completed_at) AS INTEGER) = ?";
    params.push(month);
  }

  query += ' GROUP BY week_number, year, platform ORDER BY year, week_number';
  return getDb().prepare(query).all(...params);
}

// ─── Message Operations ─────────────────────────────────────────────────────

export function insertMessage(message) {
  const stmt = getDb().prepare(`
    INSERT INTO messages (ticket_id, comment_id, body, created_by, created_at_remote, source)
    VALUES (@ticket_id, @comment_id, @body, @created_by, @created_at_remote, @source)
  `);
  return stmt.run(message);
}

export function getMessagesByTicketId(ticketId) {
  return getDb().prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at_remote ASC').all(ticketId);
}

export function getLatestMessage(ticketId) {
  return getDb().prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at_remote DESC LIMIT 1').get(ticketId);
}

// ─── Failed Accounts Operations ─────────────────────────────────────────────

export function insertFailedAccount(failedAccount) {
  const stmt = getDb().prepare(`
    INSERT INTO failed_accounts (csv_line, raw_data, platform, failure_reason, username)
    VALUES (@csv_line, @raw_data, @platform, @failure_reason, @username)
  `);
  return stmt.run(failedAccount);
}

export function getAllFailedAccounts() {
  return getDb().prepare('SELECT * FROM failed_accounts ORDER BY created_at DESC').all();
}

export function getFailedAccountCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM failed_accounts').get().count;
}

export function deleteFailedAccount(id) {
  return getDb().prepare('DELETE FROM failed_accounts WHERE id = ?').run(id);
}

// ─── Settings Operations ────────────────────────────────────────────────────

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  return getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getAllSettings() {
  const rows = getDb().prepare('SELECT * FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────

export function getDashboardStats() {
  const db = getDb();
  return {
    totalAccounts: db.prepare('SELECT COUNT(*) as c FROM accounts').get().c,
    authenticatedAccounts: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE login_status = 'authenticated'").get().c,
    pendingAccounts: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE login_status = 'pending'").get().c,
    manualLoginRequired: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE login_status = 'manual_login_required'").get().c,
    failedAccounts: db.prepare('SELECT COUNT(*) as c FROM failed_accounts').get().c,
    totalTickets: db.prepare('SELECT COUNT(*) as c FROM tickets').get().c,
    openTickets: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'Open'").get().c,
    awaitingReply: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'Awaiting Reply'").get().c,
    awaitingResponse: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'Awaiting Response'").get().c,
    completedTickets: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'Completed'").get().c,
    xboxTickets: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE platform = 'XBL'").get().c,
    psnTickets: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE platform = 'PSN'").get().c,
    xboxAccounts: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE platform = 'XBL'").get().c,
    psnAccounts: db.prepare("SELECT COUNT(*) as c FROM accounts WHERE platform = 'PSN'").get().c,
  };
}
