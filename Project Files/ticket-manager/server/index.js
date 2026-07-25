// Express Server + WebSocket — Ticket Manager Backend
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import {
  initDatabase, getAllAccounts, getAccountById, insertAccount,
  updateAccountAuth, updateAccountLoginStatus, updateAccountNotes,
  updateAccountManualAuth, deleteAccount, getAccountsByStatus,
  getAllTickets, getTicketById, insertTicket, updateTicketStatus,
  updateTicketNotes, deleteTicket, getWeeklyStats,
  getMessagesByTicketId, insertMessage,
  getAllFailedAccounts, getFailedAccountCount, insertFailedAccount, deleteFailedAccount,
  getSetting, setSetting, getAllSettings, getDashboardStats, getAuthenticatedAccounts,
} from './database.js';

import { parseCSV, validateManualAuthJson } from './csv-parser.js';
import { authenticate, refreshToken as ubiRefreshToken } from './ubisoft-api.js';
import { startTokenManager, refreshSingleToken, bulkLoginAll } from './token-manager.js';
import { createTicketForAccount, closeTicketById, regenerateTicket, replyToTicket } from './ticket-creator.js';
import { startTicketMonitor, pollTicketNow } from './ticket-monitor.js';
import { getCaptchaBalance } from './captcha-solver.js';
import { getSuggestedReply } from './ai-assistant.js';
import { launchPSNBrowser, launchXboxBrowser, getActiveBrowsers, isBrowserOpen } from './camofox-launcher.js';
import { submitViaRealBrowser } from './form-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3950;

// ─── Express Setup ──────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Serve static files from dist in production
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// ─── Initialize DB ──────────────────────────────────────────────────────────

initDatabase();

// ─── WebSocket Setup ────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log('[WS] Client connected. Total:', wsClients.size);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('[WS] Client disconnected. Total:', wsClients.size);
  });
});

function broadcast(data) {
  try {
    const message = JSON.stringify(data);
    for (const client of wsClients) {
      try {
        if (client.readyState === 1) { // OPEN
          client.send(message);
        }
      } catch (e) {
        console.error('[WS] Send error to client, removing:', e.message);
        wsClients.delete(client);
      }
    }
  } catch (e) {
    console.error('[WS] Broadcast error:', e.message);
  }
}

// ─── API Routes ─────────────────────────────────────────────────────────────

// --- Dashboard ---
app.get('/api/dashboard', (req, res) => {
  try {
    const stats = getDashboardStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Accounts ---
app.get('/api/accounts', (req, res) => {
  try {
    const { status } = req.query;
    const accounts = status ? getAccountsByStatus(status) : getAllAccounts();
    // Don't send sensitive fields to frontend in list view
    const safeAccounts = accounts.map(a => ({
      ...a,
      login_password: '••••••',
      platform_login_password: '••••••',
      ubisoft_token: a.ubisoft_token ? '••••' + a.ubisoft_token.slice(-8) : null,
    }));
    res.json(safeAccounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts/:id', (req, res) => {
  try {
    const account = getAccountById(parseInt(req.params.id));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/:id/notes', (req, res) => {
  try {
    const { notes } = req.body;
    updateAccountNotes(parseInt(req.params.id), notes);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Retry Login for accounts that failed ---
app.post('/api/accounts/:id/retry-login', async (req, res) => {
  try {
    const account = getAccountById(parseInt(req.params.id));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const proxy = getSetting('proxy_us');
    const result = await attemptLogin(parseInt(req.params.id), account, proxy);
    broadcast({ type: 'account_updated', accountId: parseInt(req.params.id) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Bulk login all non-authenticated accounts (fire and forget, progress via WS) ---
app.post('/api/accounts/bulk-login', async (req, res) => {
  try {
    // Respond immediately, run in background
    res.json({ success: true, message: 'Bulk login started — watch status via WebSocket' });
    bulkLoginAll(broadcast).catch(err => {
      console.error('[BULK LOGIN] Fatal error:', err.message);
      broadcast({ type: 'system_error', message: `Bulk login error: ${err.message}` });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CamoFox Browser ---
app.post('/api/accounts/:id/browser/psn', (req, res) => {
  try {
    const account = getAccountById(parseInt(req.params.id));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (isBrowserOpen(account.id)) {
      return res.status(409).json({ error: 'Browser already open for this account' });
    }
    const result = launchPSNBrowser(account, broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/browser/xbox', (req, res) => {
  try {
    const account = getAccountById(parseInt(req.params.id));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (isBrowserOpen(account.id)) {
      return res.status(409).json({ error: 'Browser already open for this account' });
    }
    const result = launchXboxBrowser(account, broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/browsers', (req, res) => {
  try {
    res.json(getActiveBrowsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/manual-auth', (req, res) => {
  try {
    const { authJson } = req.body;
    const validation = validateManualAuthJson(authJson);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    updateAccountManualAuth(parseInt(req.params.id), authJson);
    broadcast({ type: 'account_updated', accountId: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/refresh-token', async (req, res) => {
  try {
    const result = await refreshSingleToken(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    deleteAccount(parseInt(req.params.id));
    broadcast({ type: 'account_deleted', accountId: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CSV Import ---
app.post('/api/import/csv', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file provided' });
    }

    const csvContent = req.file.buffer.toString('utf-8');
    const autoCreate = req.body.autoCreateTickets === 'true';
    const { accounts, errors } = parseCSV(csvContent);

    const imported = [];
    const loginResults = [];
    const proxy = getSetting('proxy_us');

    for (const account of accounts) {
      const result = insertAccount(account);
      const accountId = result.lastInsertRowid;
      imported.push({ id: accountId, username: account.username, platform: account.platform });

      const loginResult = await attemptLogin(accountId, account, proxy);
      loginResults.push(loginResult);
      await sleep(1500);
    }

    for (const error of errors) {
      insertFailedAccount({
        csv_line: error.line, raw_data: error.raw,
        platform: null, failure_reason: error.reason, username: null,
      });
    }

    broadcast({ type: 'import_complete', count: imported.length });

    // Auto-create tickets for all successfully authenticated accounts
    const ticketResults = [];
    if (autoCreate) {
      const authenticated = loginResults.filter(r => r.status === 'authenticated');
      broadcast({ type: 'auto_ticket_start', total: authenticated.length });

      for (const lr of authenticated) {
        try {
          const result = await createTicketForAccount(lr.accountId, broadcast);
          ticketResults.push({ accountId: lr.accountId, username: lr.username, ...result });
          await sleep(3000); // Longer delay between ticket creations (captcha + API)
        } catch (e) {
          ticketResults.push({ accountId: lr.accountId, username: lr.username, success: false, error: e.message });
        }
      }

      broadcast({ type: 'auto_ticket_complete', total: ticketResults.length, success: ticketResults.filter(r => r.success).length });
    }

    res.json({
      success: true,
      imported: imported.length,
      errors: errors.length,
      loginResults,
      parseErrors: errors,
      ticketResults: autoCreate ? ticketResults : undefined,
    });
  } catch (err) {
    console.error('[IMPORT] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual CSV text import (paste instead of file upload)
app.post('/api/import/csv-text', async (req, res) => {
  try {
    const { csvContent, autoCreateTickets } = req.body;
    if (!csvContent) return res.status(400).json({ error: 'No CSV content provided' });

    const autoCreate = autoCreateTickets === true || autoCreateTickets === 'true';
    const { accounts, errors } = parseCSV(csvContent);

    const imported = [];
    const loginResults = [];
    const proxy = getSetting('proxy_us');

    for (const account of accounts) {
      const result = insertAccount(account);
      const accountId = result.lastInsertRowid;
      imported.push({ id: accountId, username: account.username, platform: account.platform });

      const loginResult = await attemptLogin(accountId, account, proxy);
      loginResults.push(loginResult);
      await sleep(1500);
    }

    for (const error of errors) {
      insertFailedAccount({
        csv_line: error.line, raw_data: error.raw,
        platform: null, failure_reason: error.reason, username: null,
      });
    }

    broadcast({ type: 'import_complete', count: imported.length });

    const ticketResults = [];
    if (autoCreate) {
      const authenticated = loginResults.filter(r => r.status === 'authenticated');
      broadcast({ type: 'auto_ticket_start', total: authenticated.length });

      for (const lr of authenticated) {
        try {
          const result = await createTicketForAccount(lr.accountId, broadcast);
          ticketResults.push({ accountId: lr.accountId, username: lr.username, ...result });
          await sleep(3000);
        } catch (e) {
          ticketResults.push({ accountId: lr.accountId, username: lr.username, success: false, error: e.message });
        }
      }

      broadcast({ type: 'auto_ticket_complete', total: ticketResults.length, success: ticketResults.filter(r => r.success).length });
    }

    res.json({
      success: true,
      imported: imported.length,
      errors: errors.length,
      loginResults,
      parseErrors: errors,
      ticketResults: autoCreate ? ticketResults : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Tickets ---
app.get('/api/tickets', (req, res) => {
  try {
    const { platform, status, date } = req.query;
    const filters = {};
    if (platform) filters.platform = platform;
    if (status) filters.status = status;
    if (date) filters.date = date;
    const tickets = getAllTickets(filters);
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/:id', (req, res) => {
  try {
    const ticket = getTicketById(parseInt(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tickets/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    updateTicketStatus(parseInt(req.params.id), status);
    broadcast({ type: 'ticket_updated', ticketId: parseInt(req.params.id), status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tickets/:id/notes', (req, res) => {
  try {
    const { notes } = req.body;
    updateTicketNotes(parseInt(req.params.id), notes);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tickets/:id', (req, res) => {
  try {
    deleteTicket(parseInt(req.params.id));
    broadcast({ type: 'ticket_deleted', ticketId: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete tickets by filter
app.post('/api/tickets/bulk-delete', (req, res) => {
  try {
    const { platform, status } = req.body;
    const tickets = getAllTickets({ platform, status });
    let deleted = 0;
    for (const t of tickets) {
      deleteTicket(t.id);
      deleted++;
    }
    broadcast({ type: 'tickets_bulk_deleted', count: deleted });
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Messages ---
app.get('/api/tickets/:id/messages', (req, res) => {
  try {
    const messages = getMessagesByTicketId(parseInt(req.params.id));
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Ticket Operations (Part 2) ---
app.post('/api/tickets/create/:accountId', async (req, res) => {
  try {
    const result = await createTicketForAccount(parseInt(req.params.accountId), broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit ticket via visible Chrome browser (form-bot) — bypasses reCAPTCHA headless detection
app.post('/api/tickets/form-bot/:accountId', async (req, res) => {
  try {
    const account = getAccountById(parseInt(req.params.accountId));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.login_status !== 'authenticated') {
      return res.status(400).json({ error: 'Account not authenticated' });
    }
    broadcast({ type: 'form_bot_started', accountId: account.id, username: account.username });
    const result = await submitViaRealBrowser(account, { broadcastFn: broadcast });
    if (result.success) {
      // Save to DB
      const contactEmail = account.platform_login_email || account.backup_email || account.login_email;
      const dbResult = insertTicket({
        account_id: account.id,
        case_number: result.caseNumber,
        case_id_full: result.caseIdFull || result.caseNumber,
        status: 'Open',
        platform: account.platform,
        contact_email: contactEmail,
        lost_email: account.login_email,
        notes: 'Created via form-bot (visible Chrome)',
      });
      broadcast({ type: 'ticket_created', accountId: account.id, ticketId: dbResult.id, caseNumber: result.caseNumber });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/close', async (req, res) => {
  try {
    const result = await closeTicketById(parseInt(req.params.id), broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/regenerate', async (req, res) => {
  try {
    const result = await regenerateTicket(parseInt(req.params.id), broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/reply', async (req, res) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });
    const result = await replyToTicket(parseInt(req.params.id), body.trim(), broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/poll', async (req, res) => {
  try {
    const result = await pollTicketNow(parseInt(req.params.id), broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/captcha/balance', async (req, res) => {
  try {
    const result = await getCaptchaBalance();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI Suggestions ---
app.post('/api/tickets/:id/suggest', async (req, res) => {
  try {
    const ticket = getTicketById(parseInt(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const account = getAccountById(ticket.account_id);
    const messages = getMessagesByTicketId(ticket.id);
    const result = await getSuggestedReply(messages, {
      platform: ticket.platform,
      username: account?.username,
      contactEmail: ticket.contact_email,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Weekly Stats ---
app.get('/api/stats/weekly', (req, res) => {
  try {
    const { year, month } = req.query;
    const stats = getWeeklyStats(
      year ? parseInt(year) : null,
      month ? parseInt(month) : null
    );
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Failed Accounts ---
app.get('/api/failed-accounts', (req, res) => {
  try {
    const accounts = getAllFailedAccounts();
    const count = getFailedAccountCount();
    res.json({ accounts, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/failed-accounts/:id', (req, res) => {
  try {
    deleteFailedAccount(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
  try {
    const settings = getAllSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    setSetting(key, value);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback for SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run npm run build or use npm run dev.');
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function attemptLogin(accountId, account, proxy) {
  try {
    const result = await authenticate(account.login_email, account.login_password, proxy);

    if (result.success) {
      updateAccountAuth(accountId, {
        ubisoft_token: result.token,
        token_expiry: result.expiration,
        session_id: result.sessionId,
        profile_id: result.profileId,
        user_id: result.userId,
        auth_data_json: JSON.stringify(result.data),
      });

      broadcast({
        type: 'account_authenticated',
        accountId,
        username: account.username,
      });

      return { accountId, username: account.username, status: 'authenticated' };
    } else {
      // Login failed — mark as manual_login_required
      updateAccountLoginStatus(accountId, 'manual_login_required');

      broadcast({
        type: 'account_login_failed',
        accountId,
        username: account.username,
        reason: result.reason,
      });

      return { accountId, username: account.username, status: 'manual_login_required', reason: result.reason };
    }
  } catch (err) {
    updateAccountLoginStatus(accountId, 'manual_login_required');
    return { accountId, username: account.username, status: 'error', reason: err.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Global Error Handlers (NEVER crash the process) ────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (process NOT killed):', err.message);
  console.error(err.stack);
  broadcast({ type: 'system_error', message: `Uncaught error: ${err.message}` });
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection (process NOT killed):', reason);
  broadcast({ type: 'system_error', message: `Unhandled rejection: ${String(reason)}` });
});

// ─── Start Server ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  🎫  Ticket Manager Backend running at http://localhost:${PORT}`);
  console.log(`  📡  WebSocket server at ws://localhost:${PORT}/ws\n`);

  // Start the token refresh manager
  try { startTokenManager(broadcast); } catch (e) { console.error('[INIT] Token manager start failed:', e.message); }

  // Start the ticket monitor (polls for status changes & new messages)
  try { startTicketMonitor(broadcast); } catch (e) { console.error('[INIT] Ticket monitor start failed:', e.message); }
});
