"""
database.py - SQLite Database Layer (WAL mode)

Tables: accounts, tickets, messages, failed_accounts, settings
All CRUD operations + dashboard stats.
"""
import sqlite3
import os
import json
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "tickets.db"

_db: sqlite3.Connection | None = None


def get_db() -> sqlite3.Connection:
    global _db
    if _db is None:
        raise RuntimeError("Database not initialized. Call init_database() first.")
    return _db


def init_database() -> sqlite3.Connection:
    global _db
    os.makedirs(DB_PATH.parent, exist_ok=True)
    _db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    _db.row_factory = sqlite3.Row
    _db.execute("PRAGMA journal_mode = WAL")
    _db.execute("PRAGMA synchronous = NORMAL")
    _db.execute("PRAGMA foreign_keys = ON")
    _create_tables()
    print(f"[DB] SQLite initialized at {DB_PATH}")
    return _db


def _migrate_add_column(table: str, column: str, col_type: str):
    """Add a column to a table if it doesn't exist yet (safe migration)."""
    db = get_db()
    existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
        db.commit()


def _create_tables():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            account_level INTEGER DEFAULT 0,
            login_email TEXT,
            login_password TEXT,
            platform TEXT NOT NULL CHECK(platform IN ('XBL','PSN')),
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
            login_status TEXT DEFAULT 'pending'
                CHECK(login_status IN ('pending','authenticated','manual_login_required','failed')),
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            case_number TEXT,
            case_id_full TEXT,
            status TEXT DEFAULT 'Open'
                CHECK(status IN ('Open','Awaiting Reply','Awaiting Response','Completed','Manual Login Required')),
            platform TEXT NOT NULL CHECK(platform IN ('XBL','PSN')),
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
        CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(login_status);
    """)

    # Migrations: add columns added after initial schema
    _migrate_add_column("accounts", "xbox_access_token", "TEXT")
    _migrate_add_column("accounts", "xbox_token_expiry", "TEXT")
    _migrate_add_column("tickets", "ai_auto_reply", "INTEGER DEFAULT 0")
    _migrate_add_column("tickets", "ticket_reason", "TEXT DEFAULT 'accountHackedOrTakenOver'")
    # Default settings
    defaults = {
        "proxy_us": "uorder40522_country-US:KD1syXKaSXTQJGDn@budget.legionproxy.io:1337",
        "proxy_global": "uorder40522:KD1syXKaSXTQJGDn@budget.legionproxy.io:1337",
        "captcha_api_key": "",
        "poll_interval_seconds": "45",
        "token_refresh_minutes": "50",
        "camofox_path": "camofox",
        "concurrency_threads": "3",
        "ai_api_key": "sk-z9EOr1YLqKvRqHbAuDmckWfqbtxheIB9J0jSwMOrroHaXDTz",
        "ai_model": "deepseek-v4-flash:floor",
    }
    for k, v in defaults.items():
        db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
    db.commit()


# -- Settings -----------------------------------------------------------------

def get_setting(key: str) -> str | None:
    row = get_db().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(key: str, value: str):
    get_db().execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
    get_db().commit()


def get_all_settings() -> dict:
    return {r["key"]: r["value"] for r in get_db().execute("SELECT * FROM settings").fetchall()}


# -- Accounts -----------------------------------------------------------------

def _row_to_dict(row) -> dict | None:
    if row is None:
        return None
    return dict(row)


def insert_account(acc: dict) -> int:
    db = get_db()
    cur = db.execute("""
        INSERT INTO accounts (username, account_level, login_email, login_password, platform,
            platform_login_email, platform_login_password, platform_email, platform_dob,
            backup_email, date_linked, login_status)
        VALUES (:username, :account_level, :login_email, :login_password, :platform,
            :platform_login_email, :platform_login_password, :platform_email, :platform_dob,
            :backup_email, :date_linked, :login_status)
    """, acc)
    db.commit()
    return cur.lastrowid


def update_account_auth(account_id: int, auth: dict):
    db = get_db()
    db.execute("""
        UPDATE accounts SET
            ubisoft_token = :ubisoft_token,
            token_expiry = :token_expiry,
            session_id = :session_id,
            profile_id = :profile_id,
            user_id = :user_id,
            auth_data_json = :auth_data_json,
            login_status = 'authenticated',
            updated_at = datetime('now')
        WHERE id = :id
    """, {**auth, "id": account_id})
    db.commit()


def update_account_login_status(account_id: int, status: str):
    db = get_db()
    db.execute("UPDATE accounts SET login_status = ?, updated_at = datetime('now') WHERE id = ?",
               (status, account_id))
    db.commit()


def get_all_accounts() -> list[dict]:
    return [dict(r) for r in get_db().execute("SELECT * FROM accounts ORDER BY created_at DESC").fetchall()]


def get_account_by_id(account_id: int) -> dict | None:
    return _row_to_dict(get_db().execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone())


def get_authenticated_accounts() -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM accounts WHERE login_status = 'authenticated' ORDER BY created_at DESC"
    ).fetchall()]


def delete_account(account_id: int):
    db = get_db()
    db.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    db.commit()


def update_account_notes(account_id: int, notes: str):
    db = get_db()
    db.execute("UPDATE accounts SET notes = ?, updated_at = datetime('now') WHERE id = ?",
               (notes, account_id))
    db.commit()


# -- Tickets ------------------------------------------------------------------

def insert_ticket(ticket: dict) -> int:
    db = get_db()
    now = datetime.utcnow()
    week_number = now.isocalendar()[1]
    year = now.year
    cur = db.execute("""
        INSERT INTO tickets (account_id, case_number, case_id_full, status, platform,
            contact_email, lost_email, week_number, year, notes, ticket_reason)
        VALUES (:account_id, :case_number, :case_id_full, :status, :platform,
            :contact_email, :lost_email, :week_number, :year, :notes, :ticket_reason)
    """, {**ticket, "week_number": week_number, "year": year,
          "notes": ticket.get("notes", ""),
          "ticket_reason": ticket.get("ticket_reason", "accountHackedOrTakenOver")})
    db.commit()
    return cur.lastrowid


def update_ticket_status(ticket_id: int, status: str):
    db = get_db()
    if status == "Completed":
        db.execute("""
            UPDATE tickets SET status = ?, completed_at = datetime('now'),
                closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
        """, (status, ticket_id))
    else:
        db.execute("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?",
                   (status, ticket_id))
    db.commit()


def get_ticket_by_id(ticket_id: int) -> dict | None:
    return _row_to_dict(get_db().execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone())


def get_ticket_by_account_id(account_id: int) -> dict | None:
    return _row_to_dict(get_db().execute(
        "SELECT * FROM tickets WHERE account_id = ? ORDER BY created_at DESC LIMIT 1", (account_id,)
    ).fetchone())


def get_all_tickets(filters: dict | None = None) -> list[dict]:
    q = """SELECT t.*, a.username, a.login_email, a.login_status
           FROM tickets t JOIN accounts a ON t.account_id = a.id WHERE 1=1"""
    params = []
    if filters:
        if filters.get("platform"):
            q += " AND t.platform = ?"
            params.append(filters["platform"])
        if filters.get("status"):
            q += " AND t.status = ?"
            params.append(filters["status"])
    q += " ORDER BY t.created_at DESC"
    return [dict(r) for r in get_db().execute(q, params).fetchall()]


def delete_ticket(ticket_id: int):
    db = get_db()
    db.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,))
    db.commit()


def update_ticket_notes(ticket_id: int, notes: str):
    db = get_db()
    db.execute("UPDATE tickets SET notes = ?, updated_at = datetime('now') WHERE id = ?",
               (notes, ticket_id))
    db.commit()


def bulk_delete_tickets(platform: str | None = None, status: str | None = None) -> int:
    db = get_db()
    q = "DELETE FROM tickets WHERE 1=1"
    params = []
    if platform:
        q += " AND platform = ?"
        params.append(platform)
    if status:
        q += " AND status = ?"
        params.append(status)
    cur = db.execute(q, params)
    db.commit()
    return cur.rowcount


def get_weekly_stats(year: int) -> list[dict]:
    """Returns weekly ticket stats grouped by platform (all statuses)."""
    db = get_db()
    rows = db.execute("""
        SELECT week_number, platform, COUNT(*) as count
        FROM tickets
        WHERE year = ?
        GROUP BY week_number, platform
        ORDER BY week_number
    """, (year,)).fetchall()
    return [dict(r) for r in rows]


# -- Messages -----------------------------------------------------------------

def insert_message(msg: dict) -> int:
    db = get_db()
    cur = db.execute("""
        INSERT INTO messages (ticket_id, comment_id, body, created_by, created_at_remote, source)
        VALUES (:ticket_id, :comment_id, :body, :created_by, :created_at_remote, :source)
    """, msg)
    db.commit()
    return cur.lastrowid


def get_messages_by_ticket(ticket_id: int) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at_remote ASC", (ticket_id,)
    ).fetchall()]


def get_latest_message(ticket_id: int) -> dict | None:
    return _row_to_dict(get_db().execute(
        "SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at_remote DESC LIMIT 1", (ticket_id,)
    ).fetchone())


# -- Failed Accounts ----------------------------------------------------------

def insert_failed_account(fa: dict) -> int:
    db = get_db()
    cur = db.execute("""
        INSERT INTO failed_accounts (csv_line, raw_data, platform, failure_reason, username)
        VALUES (:csv_line, :raw_data, :platform, :failure_reason, :username)
    """, fa)
    db.commit()
    return cur.lastrowid


def get_all_failed_accounts() -> list[dict]:
    return [dict(r) for r in get_db().execute("SELECT * FROM failed_accounts ORDER BY created_at DESC").fetchall()]


def delete_failed_account(fa_id: int):
    db = get_db()
    db.execute("DELETE FROM failed_accounts WHERE id = ?", (fa_id,))
    db.commit()


# -- Dashboard Stats ----------------------------------------------------------

def get_dashboard_stats() -> dict:
    db = get_db()
    def cnt(q):
        return db.execute(q).fetchone()[0]

    return {
        "totalAccounts": cnt("SELECT COUNT(*) FROM accounts"),
        "authenticatedAccounts": cnt("SELECT COUNT(*) FROM accounts WHERE login_status='authenticated'"),
        "pendingAccounts": cnt("SELECT COUNT(*) FROM accounts WHERE login_status='pending'"),
        "failedAccounts": cnt("SELECT COUNT(*) FROM failed_accounts"),
        "totalTickets": cnt("SELECT COUNT(*) FROM tickets"),
        "openTickets": cnt("SELECT COUNT(*) FROM tickets WHERE status='Open'"),
        "awaitingReply": cnt("SELECT COUNT(*) FROM tickets WHERE status='Awaiting Reply'"),
        "awaitingResponse": cnt("SELECT COUNT(*) FROM tickets WHERE status='Awaiting Response'"),
        "completedTickets": cnt("SELECT COUNT(*) FROM tickets WHERE status='Completed'"),
        "xboxTickets": cnt("SELECT COUNT(*) FROM tickets WHERE platform='XBL'"),
        "psnTickets": cnt("SELECT COUNT(*) FROM tickets WHERE platform='PSN'"),
        "xboxAccounts": cnt("SELECT COUNT(*) FROM accounts WHERE platform='XBL'"),
        "psnAccounts": cnt("SELECT COUNT(*) FROM accounts WHERE platform='PSN'"),
    }


# -- Xbox Token Cache ---------------------------------------------------------

def save_xbox_token(account_id: int, access_token: str, expiry: str | None = None):
    """Cache a valid Ubisoft Xbox Bearer accessToken in the DB."""
    db = get_db()
    db.execute(
        "UPDATE accounts SET xbox_access_token = ?, xbox_token_expiry = ?, updated_at = datetime('now') WHERE id = ?",
        (access_token, expiry, account_id)
    )
    db.commit()


def get_xbox_token(account_id: int) -> str | None:
    """Return cached Xbox accessToken if it exists and is not expired."""
    row = _row_to_dict(get_db().execute(
        "SELECT xbox_access_token, xbox_token_expiry FROM accounts WHERE id = ?",
        (account_id,)
    ).fetchone())
    if not row:
        return None
    tok = row.get("xbox_access_token")
    if not tok:
        return None
    # Check expiry
    expiry = row.get("xbox_token_expiry")
    if expiry:
        try:
            from datetime import timezone
            exp_dt = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) >= exp_dt:
                return None  # expired
        except Exception:
            pass
    return tok


# -- AI Auto-Reply Toggle -----------------------------------------------------

def set_ticket_ai_auto(ticket_id: int, enabled: bool):
    db = get_db()
    db.execute("UPDATE tickets SET ai_auto_reply = ?, updated_at = datetime('now') WHERE id = ?",
               (1 if enabled else 0, ticket_id))
    db.commit()


def get_ai_auto_tickets() -> list[dict]:
    """Get all tickets that have AI auto-reply enabled and are not completed."""
    return [dict(r) for r in get_db().execute(
        """SELECT t.*, a.username, a.login_email, a.ubisoft_token, a.session_id
           FROM tickets t JOIN accounts a ON t.account_id = a.id
           WHERE t.ai_auto_reply = 1 AND t.status != 'Completed'"""
    ).fetchall()]
