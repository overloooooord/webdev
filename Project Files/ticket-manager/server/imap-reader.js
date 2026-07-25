/**
 * IMAP Verification Code Reader
 *
 * Ported from Auto_Xbox_Linker_fixed/utils/imap_helper.py
 *
 * Features:
 *  - Auto-detect IMAP host by email domain
 *  - SSL/TLS support
 *  - Scan INBOX + Spam/Junk folders
 *  - UID-based filtering (only new messages)
 *  - Regex extraction of 4-7 digit verification codes
 *  - Skip notification-only emails (unusual sign-in, password changed)
 *  - Poll-based waiting with configurable timeout
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';

// ─── IMAP Host Configuration ────────────────────────────────────────────────
// Ported directly from Auto_Xbox_Linker_fixed config.py + imap_helper.py

const IMAP_HOSTS = {
  'rambler.ru':         { host: 'imap.rambler.ru',          port: 993, tls: true },
  'mail.ru':            { host: 'imap.mail.ru',             port: 993, tls: true },
  'inbox.ru':           { host: 'imap.mail.ru',             port: 993, tls: true },
  'list.ru':            { host: 'imap.mail.ru',             port: 993, tls: true },
  'bk.ru':              { host: 'imap.mail.ru',             port: 993, tls: true },
  'firstmail.ltd':      { host: 'imap.firstmail.ltd',       port: 993, tls: true },
  'streetwormail.com':  { host: 'mail.streetwormail.com',   port: 993, tls: true },
  'vargosmail.com':     { host: 'imap.firstmail.ltd',       port: 993, tls: true },
  'notlettersmail.com': { host: 'mail.notlettersmail.com',  port: 143, tls: false },
  'belettersmail.com':  { host: 'mail.belettersmail.com',   port: 143, tls: false },
  'onelettersmail.com': { host: 'mail.onelettersmail.com',  port: 143, tls: false },
  'gmail.com':          { host: 'imap.gmail.com',           port: 993, tls: true },
  'outlook.com':        { host: 'imap-mail.outlook.com',    port: 993, tls: true },
  'hotmail.com':        { host: 'imap-mail.outlook.com',    port: 993, tls: true },
  'live.com':           { host: 'imap-mail.outlook.com',    port: 993, tls: true },
  'yahoo.com':          { host: 'imap.mail.yahoo.com',      port: 993, tls: true },
};

// Patterns to extract verification codes (ported from Python)
const CODE_PATTERNS = [
  /(?:security\s*code|verification\s*code|code)\s*(?:is|:)?\s*(\d{4,7})/i,
  /(\d{4,7})\s*(?:is your)/i,
  /<td[^>]*>(\d{4,7})<\/td>/i,
  /(?:^|\n)\s*(\d{4,7})\s*(?:\n|$)/,
  /(?:code|código|код)[:\s]*?(\d{4,7})/i,
  /style="[^"]*font-size[^"]*"[^>]*>(\d{4,7})</i,
];

// Emails to skip (notifications, not verification codes)
const SKIP_SUBJECTS = [
  'unusual sign-in',
  'unusual activity',
  'password changed',
  'password was changed',
  'review recent activity',
  'new sign-in',
  'welcome to',
];

/**
 * Get IMAP configuration for an email domain
 */
function getImapConfig(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  if (IMAP_HOSTS[domain]) {
    return IMAP_HOSTS[domain];
  }

  // Fallback: try common patterns
  return {
    host: `mail.${domain}`,
    port: 143,
    tls: false,
  };
}

/**
 * IMAP Code Reader — connects, searches, and extracts verification codes
 */
export class IMAPCodeReader {
  /**
   * @param {string} email    - IMAP email address
   * @param {string} password - IMAP password
   * @param {string|null} host - Override IMAP host
   * @param {number|null} port - Override IMAP port
   */
  constructor(email, password, host = null, port = null) {
    const autoConfig = getImapConfig(email);
    this.email = email;
    this.imapConfig = {
      user: email,
      password,
      host: host || autoConfig?.host || `mail.${email.split('@')[1]}`,
      port: port || autoConfig?.port || 993,
      tls: autoConfig?.tls ?? true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    };
    this.connection = null;
    this.folders = ['INBOX'];
  }

  /**
   * Connect to IMAP server
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.connection = new Imap(this.imapConfig);

      this.connection.once('ready', () => {
        console.log(`[IMAP] ✓ Connected to ${this.imapConfig.host} as ${this.email}`);
        this._detectFolders().then(resolve).catch(resolve); // continue even if folder detection fails
      });

      this.connection.once('error', (err) => {
        console.error(`[IMAP] Connection error for ${this.email}:`, err.message);
        reject(err);
      });

      this.connection.connect();
    });
  }

  /**
   * Disconnect from IMAP server
   */
  disconnect() {
    try {
      if (this.connection) {
        this.connection.end();
        this.connection = null;
      }
    } catch {
      // ignore
    }
  }

  /**
   * Auto-detect available folders (INBOX + Spam/Junk)
   */
  async _detectFolders() {
    return new Promise((resolve) => {
      this.connection.getBoxes((err, boxes) => {
        if (err) {
          console.warn(`[IMAP] Could not list folders: ${err.message}`);
          resolve();
          return;
        }

        const folderNames = this._flattenBoxes(boxes);
        const spamFolders = folderNames.filter(name =>
          /spam|junk|bulk|unwanted/i.test(name)
        );

        this.folders = ['INBOX', ...spamFolders];
        console.log(`[IMAP] Folders to scan: ${this.folders.join(', ')}`);
        resolve();
      });
    });
  }

  /**
   * Recursively flatten mailbox hierarchy into folder paths
   */
  _flattenBoxes(boxes, prefix = '') {
    const result = [];
    for (const [name, box] of Object.entries(boxes)) {
      const fullPath = prefix ? `${prefix}${box.delimiter || '/'}${name}` : name;
      result.push(fullPath);
      if (box.children) {
        result.push(...this._flattenBoxes(box.children, fullPath));
      }
    }
    return result;
  }

  /**
   * Get a verification code from email.
   *
   * @param {string} senderFilter   - Substring to match in sender (default: 'microsoft')
   * @param {number} maxWaitSec     - Maximum seconds to wait
   * @param {number} pollIntervalMs - Polling interval in ms
   * @param {Date|null} notBefore   - Only consider emails after this date
   * @returns {Promise<{success: boolean, code?: string, error?: string}>}
   */
  async getVerificationCode({
    senderFilter = 'microsoft',
    maxWaitSec = 60,
    pollIntervalMs = 3000,
    notBefore = null,
  } = {}) {
    if (!this.connection) {
      try {
        await this.connect();
      } catch (e) {
        return { success: false, error: `IMAP connect failed: ${e.message}` };
      }
    }

    const deadline = Date.now() + maxWaitSec * 1000;
    const startTime = notBefore || new Date(Date.now() - 120000); // default: 2 min ago

    console.log(`[IMAP] Searching for verification code from '${senderFilter}' (max ${maxWaitSec}s)...`);

    while (Date.now() < deadline) {
      for (const folder of this.folders) {
        try {
          const code = await this._searchFolder(folder, senderFilter, startTime);
          if (code) {
            console.log(`[IMAP] ✓ Verification code found: ${code} (in ${folder})`);
            return { success: true, code };
          }
        } catch (e) {
          console.warn(`[IMAP] Error searching ${folder}: ${e.message}`);
        }
      }

      const remaining = Math.round((deadline - Date.now()) / 1000);
      if (remaining > 0) {
        console.log(`[IMAP] No code yet, retrying in ${pollIntervalMs / 1000}s... (${remaining}s left)`);
        await sleep(pollIntervalMs);
      }
    }

    return { success: false, error: `No verification code found within ${maxWaitSec}s` };
  }

  /**
   * Search a single folder for verification emails
   */
  _searchFolder(folderName, senderFilter, notBefore) {
    return new Promise((resolve, reject) => {
      this.connection.openBox(folderName, true, (err) => {
        if (err) {
          reject(err);
          return;
        }

        const sinceDate = notBefore.toISOString().split('T')[0]; // YYYY-MM-DD
        const searchCriteria = [
          ['SINCE', sinceDate],
          ['FROM', senderFilter],
        ];

        this.connection.search(searchCriteria, (searchErr, uids) => {
          if (searchErr) {
            reject(searchErr);
            return;
          }

          if (!uids || uids.length === 0) {
            resolve(null);
            return;
          }

          // Fetch most recent messages first (reverse order)
          const recentUids = uids.slice(-10).reverse();
          const fetch = this.connection.fetch(recentUids, { bodies: '' });
          const codePromises = [];

          fetch.on('message', (msg) => {
            codePromises.push(
              new Promise((resolveMsg) => {
                msg.on('body', (stream) => {
                  let rawEmail = '';
                  stream.on('data', (chunk) => { rawEmail += chunk.toString('utf8'); });
                  stream.on('end', () => {
                    simpleParser(rawEmail)
                      .then((parsed) => resolveMsg(this._extractCodeFromEmail(parsed, notBefore)))
                      .catch(() => resolveMsg(null));
                  });
                });
                msg.once('error', () => resolveMsg(null));
              })
            );
          });

          fetch.once('end', async () => {
            const results = await Promise.all(codePromises);
            const code = results.find(r => r !== null);
            resolve(code || null);
          });

          fetch.once('error', (e) => {
            reject(e);
          });
        });
      });
    });
  }

  /**
   * Extract a verification code from a parsed email
   */
  _extractCodeFromEmail(parsed, notBefore) {
    // Check date
    if (notBefore && parsed.date && parsed.date < notBefore) {
      return null;
    }

    // Check subject — skip notification emails
    const subject = (parsed.subject || '').toLowerCase();
    for (const skip of SKIP_SUBJECTS) {
      if (subject.includes(skip)) {
        return null;
      }
    }

    // Search in both text and HTML body
    const textBody = parsed.text || '';
    const htmlBody = parsed.html || '';
    const searchIn = textBody + '\n' + htmlBody;

    for (const pattern of CODE_PATTERNS) {
      const match = searchIn.match(pattern);
      if (match && match[1]) {
        const candidate = match[1];

        // Filter out years (2023-2039)
        if (/^20[2-3]\d$/.test(candidate)) {
          continue;
        }

        // Valid code: 4-7 digits
        if (candidate.length >= 4 && candidate.length <= 7) {
          return candidate;
        }
      }
    }

    return null;
  }
}

/**
 * Quick helper: get a verification code for an email address
 *
 * @param {string} email     - The email to check
 * @param {string} password  - IMAP password
 * @param {object} options   - Options (senderFilter, maxWaitSec, etc.)
 * @returns {Promise<{success: boolean, code?: string, error?: string}>}
 */
export async function getVerificationCodeForEmail(email, password, options = {}) {
  const reader = new IMAPCodeReader(email, password);
  try {
    const result = await reader.getVerificationCode(options);
    return result;
  } finally {
    reader.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { getImapConfig, IMAP_HOSTS };
