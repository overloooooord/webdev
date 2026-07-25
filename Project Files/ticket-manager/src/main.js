// Ticket Manager - Frontend Entry Point
import './styles/index.css';

// State
let currentPage = 'dashboard';
let ws = null;
let dashboardData = null;
let currentChatTicketId = null; // Track which ticket chat is currently open
window._startTime = Date.now();


// WebSocket
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('ws-status-dot').classList.remove('disconnected');
    document.getElementById('ws-status-text').textContent = 'Connected';
  };

  ws.onclose = () => {
    document.getElementById('ws-status-dot').classList.add('disconnected');
    document.getElementById('ws-status-text').textContent = 'Disconnected';
    setTimeout(connectWebSocket, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch (e) { console.error('[WS] Parse error:', e); }
  };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'import_complete':
      showToast(`Imported ${data.count} accounts`, 'success');
      if (currentPage === 'dashboard') renderDashboard();
      break;
    case 'account_authenticated':
      showToast(`${data.username} authenticated`, 'success');
      if (currentPage === 'accounts') renderAccounts();
      break;
    case 'account_login_failed':
      showToast(`${data.username} login failed: ${data.reason}`, 'warning');
      break;
    case 'token_expired':
      showToast(`Token expired for ${data.username}`, 'error');
      break;
    case 'new_agent_message':
      showToast(`🔔 ${data.username}: Agent replied!`, 'info');
      sendBrowserNotification(`Agent replied on ${data.username}`, data.messagePreview);
      playNotificationSound();
      if (currentPage === 'dashboard') renderDashboard();
      // Smooth chat refresh - only update messages, don't re-render full page
      if (currentChatTicketId && data.ticketId === currentChatTicketId) {
        refreshChatMessages(currentChatTicketId);
      }
      break;
    case 'ticket_created':
      showToast(`Ticket #${data.caseNumber} created for ${data.username}`, 'success');
      if (currentPage === 'dashboard') renderDashboard();
      if (currentPage === 'tickets') loadTickets();
      break;
    case 'ticket_closed':
      showToast(`Ticket #${data.caseNumber} closed`, 'info');
      if (currentPage === 'dashboard') renderDashboard();
      if (currentPage === 'tickets') loadTickets();
      break;
    case 'ticket_regenerated':
      showToast(`Ticket regenerated -> #${data.newCaseNumber}`, 'success');
      if (currentPage === 'dashboard') renderDashboard();
      if (currentPage === 'tickets') loadTickets();
      break;
    case 'ticket_status_changed':
      showToast(`#${data.caseNumber}: ${data.oldStatus} -> ${data.newStatus}`, 'info');
      if (currentPage === 'dashboard') renderDashboard();
      if (currentPage === 'tickets') loadTickets();
      // Update badge in chat sidebar if viewing this ticket
      if (currentChatTicketId && data.ticketId === currentChatTicketId) {
        const badges = document.querySelectorAll('.badge[data-ticket-status]');
        badges.forEach(b => {
          b.className = `badge badge-${statusClass(data.newStatus)}`;
          b.textContent = data.newStatus;
        });
      }
      break;
    case 'message_sent':
    case 'new_messages':
    case 'ticket_updated':
      if (currentPage === 'dashboard') renderDashboard();
      if (currentPage === 'tickets') loadTickets();
      // Smooth refresh: only re-render the messages area if we're in that chat
      if (currentChatTicketId && data.ticketId === currentChatTicketId) {
        refreshChatMessages(currentChatTicketId);
      }
      break;
    case 'ticket_deleted':
    case 'account_updated':
    case 'account_deleted':
      if (currentPage === 'dashboard') renderDashboard();
      if (currentPage === 'tickets') loadTickets();
      if (currentPage === 'accounts') renderAccounts();
      break;
    case 'ticket_agent_closed':
      showToast(`⚠️ ${data.username}: Agent closed the ticket - reply to reopen it`, 'warning');
      sendBrowserNotification(`Agent closed ticket - ${data.username}`, 'You can still reply to reopen it on Ubisoft\'s side.');
      playNotificationSound();
      if (currentPage === 'tickets') loadTickets();
      if (currentPage === 'dashboard') renderDashboard();
      if (currentChatTicketId && data.ticketId === currentChatTicketId) {
        refreshChatMessages(currentChatTicketId);
      }
      break;
    case 'ticket_creating': {
      const stepLabels = {
        auth: '🔐 Refreshing auth token...',
        xbox_oauth: '🎮 Xbox OAuth login...',
        elevating: '🔑 Elevating session scope...',
        chrome_cdp: '🌐 Chrome CDP: solving captcha + submitting...',
        solving_captcha: '🧩 Solving reCAPTCHA via 2Captcha...',
        creating_ticket: '📤 Sending ticket to Ubisoft API...',
        browser_fallback: '🤖 Form-bot fallback (reCAPTCHA rejected)...',
      };
      const label = stepLabels[data.step] || `⏳ ${data.step}...`;
      showToast(`${data.username}: ${label}`, 'info');
      break;
    }
    case 'bulk_login_start':
      showToast(`🔐 Authenticating ${data.total} accounts...`, 'info');
      break;
    case 'bulk_login_complete': {
      const btn = document.getElementById('btn-auth-all');
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Auth All'; }
      showToast(`✅ Bulk login done: ${data.success}/${data.total} authenticated`, data.failed === 0 ? 'success' : 'warning');
      if (currentPage === 'accounts') renderAccounts();
      if (currentPage === 'dashboard') renderDashboard();
      break;
    }
    case 'ai_auto_replied':
      showToast(`🤖 AI auto-replied to ${data.caseNumber}: "${data.reply}"`, 'success');
      if (currentChatTicketId && data.ticketId === currentChatTicketId) {
        refreshChatMessages(currentChatTicketId);
      }
      if (currentPage === 'tickets') loadTickets();
      break;
    case 'browser_launched':
      showToast(`🌐 ${data.platform} browser launched for ${data.username}`, 'info');
      break;
  }
}

// Smooth Chat Messages Refresh (no full page reload)
async function refreshChatMessages(ticketId) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const messages = await api(`/tickets/${ticketId}/messages`);
  if (!document.getElementById('chat-messages')) return; // navigated away
  container.innerHTML = messages.length
    ? messages.map(m => chatBubble(m)).join('')
    : '<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-title">No messages yet</div><div class="empty-state-text">Waiting for agent response.</div></div>';
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

// API Helper
async function api(endpoint, options = {}) {
  const res = await fetch(`/api${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  return res.json();
}

// Navigation
function setupNavigation() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentPage = item.dataset.page;
      renderPage(currentPage);
    });
  });
}

function renderPage(page) {
  currentChatTicketId = null; // Clear chat tracking when navigating to any page
  const main = document.getElementById('main-content');
  switch (page) {
    case 'dashboard': renderDashboard(); break;
    case 'tickets': renderTickets(); break;
    case 'accounts': renderAccounts(); break;
    case 'import': renderImport(); break;
    case 'stats': renderStats(); break;
    case 'failed': renderFailed(); break;
    case 'settings': renderSettings(); break;
    default: renderDashboard();
  }
}

// Dashboard Page
async function renderDashboard() {
  const main = document.getElementById('main-content');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  main.innerHTML = `<div class="db-page">
    <div class="db-topbar">
      <div>
        <div class="db-page-title">Operations Dashboard</div>
        <div class="db-page-sub">${dateStr} &nbsp;·&nbsp; Last updated ${timeStr}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-secondary btn-sm" onclick="renderDashboard()" style="gap:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-8.3"/></svg>
          Refresh
        </button>
        <button class="btn btn-primary btn-sm" onclick="window.location.hash='import'" style="gap:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          Import CSV
        </button>
      </div>
    </div>
    <div class="db-loading"><div class="spinner"></div><span>Loading dashboard…</span></div>
  </div>`;

  const [data, statsRaw] = await Promise.all([
    api('/dashboard'),
    api('/stats/weekly?year=' + now.getFullYear()),
  ]);
  dashboardData = data;
  updateBadge('badge-tickets', data.awaitingReply);
  updateBadge('badge-failed', data.failedAccounts);

  const authRate = data.totalAccounts > 0 ? Math.round((data.authenticatedAccounts / data.totalAccounts) * 100) : 0;
  const completedRate = data.totalTickets > 0 ? Math.round((data.completedTickets / data.totalTickets) * 100) : 0;
  const uptime = Math.floor((Date.now() - window._startTime) / 60000);

  document.querySelector('.db-page').innerHTML = `
    <!-- Topbar -->
    <div class="db-topbar">
      <div>
        <div class="db-page-title">Operations Dashboard</div>
        <div class="db-page-sub">${dateStr} &nbsp;·&nbsp; Last updated ${timeStr}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-secondary btn-sm" onclick="renderDashboard()" style="gap:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-8.3"/></svg>
          Refresh
        </button>
        <button class="btn btn-primary btn-sm" onclick="window.location.hash='import'" style="gap:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          Import CSV
        </button>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="db-kpi-row">
      <div class="db-kpi" data-color="blue">
        <div class="db-kpi-icon" style="background:rgba(59,130,246,.12);color:#3b82f6">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div class="db-kpi-body">
          <div class="db-kpi-label">Total Accounts</div>
          <div class="db-kpi-val">${data.totalAccounts}</div>
          <div class="db-kpi-sub" style="color:#3b82f6">${authRate}% authenticated</div>
        </div>
        <canvas class="db-spark" id="spark-accounts" width="80" height="36"></canvas>
      </div>

      <div class="db-kpi" data-color="green">
        <div class="db-kpi-icon" style="background:rgba(34,197,94,.12);color:#22c55e">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </div>
        <div class="db-kpi-body">
          <div class="db-kpi-label">Authenticated</div>
          <div class="db-kpi-val">${data.authenticatedAccounts}</div>
          <div class="db-kpi-sub" style="color:#22c55e">Tokens active</div>
        </div>
        <canvas class="db-spark" id="spark-auth" width="80" height="36"></canvas>
      </div>

      <div class="db-kpi" data-color="purple">
        <div class="db-kpi-icon" style="background:rgba(168,85,247,.12);color:#a855f7">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.87 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </div>
        <div class="db-kpi-body">
          <div class="db-kpi-label">Total Tickets</div>
          <div class="db-kpi-val">${data.totalTickets}</div>
          <div class="db-kpi-sub" style="color:#a855f7">${completedRate}% completed</div>
        </div>
        <canvas class="db-spark" id="spark-tickets" width="80" height="36"></canvas>
      </div>

      <div class="db-kpi" data-color="amber">
        <div class="db-kpi-icon" style="background:rgba(245,158,11,.12);color:#f59e0b">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="db-kpi-body">
          <div class="db-kpi-label">Awaiting Reply</div>
          <div class="db-kpi-val">${data.awaitingReply}</div>
          <div class="db-kpi-sub" style="color:#f59e0b">Need attention</div>
        </div>
        <canvas class="db-spark" id="spark-awaiting" width="80" height="36"></canvas>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="db-charts-row">

      <!-- Weekly Activity (large) -->
      <div class="db-chart-card db-chart-lg">
        <div class="db-chart-head">
          <div>
            <div class="db-chart-title">Weekly Completed Tickets</div>
            <div class="db-chart-sub">Tickets resolved per week by platform</div>
          </div>
          <div style="display:flex;gap:12px;align-items:center">
            <div class="db-legend-item"><span style="background:#22c55e"></span>Xbox</div>
            <div class="db-legend-item"><span style="background:#3b82f6"></span>PSN</div>
          </div>
        </div>
        <canvas id="chart-weekly" height="180"></canvas>
      </div>

      <!-- Donut chart -->
      <div class="db-chart-card db-chart-sm">
        <div class="db-chart-head">
          <div>
            <div class="db-chart-title">Ticket Status</div>
            <div class="db-chart-sub">Current distribution</div>
          </div>
        </div>
        <div style="position:relative;display:flex;justify-content:center;padding:8px 0">
          <canvas id="chart-donut" width="160" height="160"></canvas>
          <div class="db-donut-center">
            <div class="db-donut-num">${data.totalTickets}</div>
            <div class="db-donut-lbl">Total</div>
          </div>
        </div>
        <div class="db-donut-legend">
          <div class="db-dl-row"><span style="background:#3b82f6"></span><span>Open</span><strong>${data.openTickets}</strong></div>
          <div class="db-dl-row"><span style="background:#f59e0b"></span><span>Awaiting Reply</span><strong>${data.awaitingReply}</strong></div>
          <div class="db-dl-row"><span style="background:#8b5cf6"></span><span>Awaiting Response</span><strong>${data.awaitingResponse ?? 0}</strong></div>
          <div class="db-dl-row"><span style="background:#22c55e"></span><span>Completed</span><strong>${data.completedTickets}</strong></div>
        </div>
      </div>
    </div>

    <!-- Bottom Row -->
    <div class="db-bottom-row">

      <!-- Platform Breakdown -->
      <div class="db-chart-card" style="flex:1">
        <div class="db-chart-head">
          <div class="db-chart-title">Platform Breakdown</div>
        </div>
        <div class="db-platform-bars">
          <div class="db-plat-row">
            <div class="db-plat-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#22c55e"><rect x="2" y="2" width="20" height="20" rx="4"/></svg>
              Xbox (XBL)
            </div>
            <div class="db-plat-track">
              <div class="db-plat-fill" style="width:${data.totalAccounts > 0 ? Math.round((data.xboxAccounts ?? 0)/data.totalAccounts*100) : 0}%;background:linear-gradient(90deg,#22c55e,#15803d)"></div>
            </div>
            <div class="db-plat-count">${data.xboxAccounts ?? 0}</div>
          </div>
          <div class="db-plat-row">
            <div class="db-plat-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#3b82f6"><rect x="2" y="2" width="20" height="20" rx="4"/></svg>
              PlayStation (PSN)
            </div>
            <div class="db-plat-track">
              <div class="db-plat-fill" style="width:${data.totalAccounts > 0 ? Math.round((data.psnAccounts ?? 0)/data.totalAccounts*100) : 0}%;background:linear-gradient(90deg,#3b82f6,#1d4ed8)"></div>
            </div>
            <div class="db-plat-count">${data.psnAccounts ?? 0}</div>
          </div>
          <div style="height:1px;background:var(--border);margin:12px 0"></div>
          <div class="db-plat-row">
            <div class="db-plat-label" style="color:var(--text-3)">Xbox Tickets</div>
            <div class="db-plat-track">
              <div class="db-plat-fill" style="width:${data.totalTickets > 0 ? Math.round(data.xboxTickets/data.totalTickets*100) : 0}%;background:linear-gradient(90deg,#22c55e,#15803d)"></div>
            </div>
            <div class="db-plat-count">${data.xboxTickets}</div>
          </div>
          <div class="db-plat-row">
            <div class="db-plat-label" style="color:var(--text-3)">PSN Tickets</div>
            <div class="db-plat-track">
              <div class="db-plat-fill" style="width:${data.totalTickets > 0 ? Math.round(data.psnTickets/data.totalTickets*100) : 0}%;background:linear-gradient(90deg,#3b82f6,#1d4ed8)"></div>
            </div>
            <div class="db-plat-count">${data.psnTickets}</div>
          </div>
        </div>
      </div>

      <!-- System Health -->
      <div class="db-chart-card" style="flex:1">
        <div class="db-chart-head">
          <div class="db-chart-title">System Health</div>
          <button class="btn btn-secondary btn-sm" onclick="refreshBrowsersList()" style="gap:5px;font-size:10px">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-8.3"/></svg>
            Refresh
          </button>
        </div>
        <div class="db-health-grid">
          <div class="db-health-item">
            <div class="db-health-dot" style="background:#22c55e;box-shadow:0 0 8px #22c55e"></div>
            <div class="db-health-info">
              <div class="db-health-name">WebSocket</div>
              <div class="db-health-val" style="color:#22c55e">● Connected</div>
            </div>
          </div>
          <div class="db-health-item">
            <div class="db-health-dot" style="background:#3b82f6;box-shadow:0 0 8px #3b82f6"></div>
            <div class="db-health-info">
              <div class="db-health-name">Token Manager</div>
              <div class="db-health-val" style="color:#3b82f6">● Active</div>
            </div>
          </div>
          <div class="db-health-item">
            <div class="db-health-dot" style="background:#22c55e;box-shadow:0 0 8px #22c55e"></div>
            <div class="db-health-info">
              <div class="db-health-name">Ticket Monitor</div>
              <div class="db-health-val" style="color:#22c55e">● Polling</div>
            </div>
          </div>
          <div class="db-health-item">
            <div class="db-health-dot" style="background:${data.failedAccounts > 0 ? '#f59e0b;box-shadow:0 0 8px #f59e0b' : '#22c55e;box-shadow:0 0 8px #22c55e'}"></div>
            <div class="db-health-info">
              <div class="db-health-name">Failed Accounts</div>
              <div class="db-health-val" style="color:${data.failedAccounts > 0 ? '#f59e0b' : '#22c55e'}">${data.failedAccounts > 0 ? '⚠ ' + data.failedAccounts + ' accounts' : '● None'}</div>
            </div>
          </div>
          <div class="db-health-item">
            <div class="db-health-dot" style="background:#a855f7;box-shadow:0 0 8px #a855f7"></div>
            <div class="db-health-info">
              <div class="db-health-name">Uptime</div>
              <div class="db-health-val" style="color:#a855f7;font-family:var(--font-data)">${uptime} min</div>
            </div>
          </div>
          <div class="db-health-item">
            <div class="db-health-dot" style="background:#22c55e;box-shadow:0 0 8px #22c55e"></div>
            <div class="db-health-info">
              <div class="db-health-name">Active Monitoring</div>
              <div class="db-health-val" style="color:#22c55e;font-family:var(--font-data)">${data.totalTickets - data.completedTickets} tickets</div>
            </div>
          </div>
        </div>
        <!-- Active Browsers Section -->
        <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
          <div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Active Browsers</div>
          <div id="db-browsers-list" style="display:flex;flex-direction:column;gap:6px">
            <div style="font-size:11px;color:var(--text-3);text-align:center;padding:8px">Loading...</div>
          </div>
        </div>
      </div>

    </div>`;

  // Draw all charts
  requestAnimationFrame(() => {
    drawWeeklyChart(statsRaw);
    drawDonutChart(data);
    drawSparkline('spark-accounts', [4,7,5,8,6,9,data.totalAccounts], '#3b82f6');
    drawSparkline('spark-auth',     [2,5,4,7,6,8,data.authenticatedAccounts], '#22c55e');
    drawSparkline('spark-tickets',  [1,3,2,5,4,6,data.totalTickets], '#a855f7');
    drawSparkline('spark-awaiting', [3,5,4,3,6,4,data.awaitingReply], '#f59e0b');
  });
  // Load active browsers list
  refreshBrowsersList();
}

// -- Sparkline --------------------------------------------------------------
function drawSparkline(id, vals, color) {
  const c = document.getElementById(id);
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.offsetWidth || 80, H = c.offsetHeight || 36;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const min = Math.min(...vals), max = Math.max(...vals, min + 1);
  const step = W / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, H - 4 - ((v - min) / (max - min)) * (H - 8)]);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '44'); grad.addColorStop(1, color + '00');
  ctx.beginPath(); ctx.moveTo(pts[0][0], H);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length-1][0], H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
}

// -- Weekly Area Chart -------------------------------------------------------
function drawWeeklyChart(stats) {
  const c = document.getElementById('chart-weekly');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.offsetWidth || 600, H = 180;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const weekMap = {};
  for (const s of stats) {
    const key = 'W' + String(s.week_number).padStart(2, '0');
    if (!weekMap[key]) weekMap[key] = { xbox: 0, psn: 0 };
    if (s.platform === 'XBL') weekMap[key].xbox += s.count;
    else weekMap[key].psn += s.count;
  }
  const weeks = Object.keys(weekMap).sort().slice(-10);

  if (!weeks.length) {
    ctx.save();
    // draw decorative empty grid
    for (let i = 0; i <= 4; i++) {
      const y = 20 + (H - 48) * (1 - i / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(W - 16, y); ctx.stroke();
    }
    // ghost bars
    const ghostW = Math.min(28, (W - 80) / 8);
    for (let i = 0; i < 8; i++) {
      const x = 44 + i * ((W - 80) / 8);
      const h = 20 + Math.random() * 60;
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.beginPath();
      ctx.roundRect(x, H - 32 - h, ghostW, h, 3);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.font = '500 12px Geist, system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Waiting for ticket activity', W / 2, H / 2 - 6);
    ctx.font = '400 10px Geist, system-ui';
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillText('Completed tickets will appear here', W / 2, H / 2 + 12);
    ctx.restore();
    return;
  }

  const maxVal = Math.max(...weeks.map(w => weekMap[w].xbox + weekMap[w].psn), 1);
  const pad = { l: 36, r: 16, t: 12, b: 28 };
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + cH - (i / 4) * cH;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.font = '9px Geist Mono, monospace';
    ctx.textAlign = 'right'; ctx.fillText(Math.round(maxVal * i / 4), pad.l - 4, y + 3);
  }

  const bW = Math.min(28, cW / weeks.length - 6);
  const gap = cW / weeks.length;

  weeks.forEach((week, i) => {
    const x = pad.l + i * gap + (gap - bW) / 2;
    const xboxH = (weekMap[week].xbox / maxVal) * cH;
    const psnH  = (weekMap[week].psn  / maxVal) * cH;
    const total = xboxH + psnH;

    // PSN segment (top)
    if (psnH > 0) {
      const g = ctx.createLinearGradient(0, pad.t + cH - total, 0, pad.t + cH - xboxH);
      g.addColorStop(0, '#60a5fa'); g.addColorStop(1, '#2563eb');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, pad.t + cH - total, bW, psnH, xboxH > 0 ? [4,4,0,0] : [4,4,4,4]);
      ctx.fill();
    }
    // Xbox segment (bottom)
    if (xboxH > 0) {
      const g = ctx.createLinearGradient(0, pad.t + cH - xboxH, 0, pad.t + cH);
      g.addColorStop(0, '#4ade80'); g.addColorStop(1, '#16a34a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, pad.t + cH - xboxH, bW, xboxH, psnH > 0 ? [0,0,4,4] : [4,4,4,4]);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.font = '9px IBM Plex Sans';
    ctx.textAlign = 'center'; ctx.fillText(week, x + bW / 2, H - 6);
  });
}

// -- Donut Chart -------------------------------------------------------------
function drawDonutChart(data) {
  const c = document.getElementById('chart-donut');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = 160 * dpr; c.height = 160 * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const cx = 80, cy = 80, r = 62, inner = 42;
  const segments = [
    { val: data.openTickets,       color: '#3b82f6' },
    { val: data.awaitingReply,     color: '#f59e0b' },
    { val: data.awaitingResponse ?? 0, color: '#8b5cf6' },
    { val: data.completedTickets,  color: '#22c55e' },
  ];
  const total = segments.reduce((s, x) => s + x.val, 0) || 1;
  let angle = -Math.PI / 2;
  for (const seg of segments) {
    const arc = (seg.val / total) * Math.PI * 2;
    if (arc < 0.01) continue;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + arc);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    angle += arc;
  }
  // Punch inner hole
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = 'var(--bg-2, #1a1f2e)';
  ctx.fill();
}




// Tickets Page
async function renderTickets() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="content-header">
      <div><div class="content-title">🎫 Tickets</div>
      <div class="content-subtitle">Manage support tickets</div></div>
      <button class="btn btn-danger" onclick="bulkDeleteTickets()">🗑 Bulk Delete</button>
    </div>
    <div class="content-body">
      <div class="filter-bar mb-4" id="ticket-filters">
        <select class="form-select" id="filter-platform"><option value="">All Platforms</option><option value="XBL">Xbox</option><option value="PSN">PlayStation</option></select>
        <select class="form-select" id="filter-status"><option value="">All Statuses</option><option value="Open">Open</option><option value="Awaiting Reply">Awaiting Reply</option><option value="Awaiting Response">Awaiting Response</option><option value="Completed">Completed</option></select>
        <input type="date" class="form-input" id="filter-date" style="width:160px" />
        <button class="btn btn-secondary" id="btn-clear-filters">✕ Clear</button>
      </div>
      <div id="tickets-list"><div class="loading-overlay"><div class="spinner"></div><span>Loading tickets...</span></div></div>
    </div>`;

  await loadTickets();

  document.getElementById('filter-platform').addEventListener('change', loadTickets);
  document.getElementById('filter-status').addEventListener('change', loadTickets);
  document.getElementById('filter-date').addEventListener('change', loadTickets);
  document.getElementById('btn-clear-filters').addEventListener('click', () => {
    document.getElementById('filter-platform').value = '';
    document.getElementById('filter-status').value = '';
    document.getElementById('filter-date').value = '';
    loadTickets();
  });
}

async function loadTickets() {
  const platform = document.getElementById('filter-platform')?.value || '';
  const status = document.getElementById('filter-status')?.value || '';
  const date = document.getElementById('filter-date')?.value || '';

  let url = '/tickets?';
  if (platform) url += `platform=${platform}&`;
  if (status) url += `status=${encodeURIComponent(status)}&`;
  if (date) url += `date=${date}&`;

  const tickets = await api(url);
  const container = document.getElementById('tickets-list');
  if (!container) return;

  if (!tickets.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎫</div><div class="empty-state-title">No tickets found</div><div class="empty-state-text">Import accounts and create tickets to get started.</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="card">
      <table class="data-table">
        <thead><tr>
          <th>Account</th><th>Platform</th><th>Status</th><th>Opened</th><th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody>
          ${tickets.map(t => `
            <tr onclick="openTicketChat(${t.id})" style="cursor:pointer">
              <td><div class="account-username">${t.username || 'Unknown'}</div><div class="text-sm text-muted">#${t.case_number || '-'}</div></td>
              <td><span class="badge badge-${t.platform === 'XBL' ? 'xbox' : 'psn'}">${t.platform === 'XBL' ? 'Xbox' : 'PSN'}</span></td>
              <td><span class="badge badge-${statusClass(t.status)}">${t.status}</span></td>
              <td class="text-sm text-muted">${formatDate(t.opened_at)}</td>
              <td class="text-right">
                <div class="btn-group" style="justify-content:flex-end">
                  <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();closeTicketAction(${t.id})">🔴 Close</button>
                  <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();regenerateTicketAction(${t.id})">🔄 Regen</button>
                  <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteTicketById(${t.id})">✕</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

// Accounts Page
let _accountsData = [];
window._accountsPage = 1;
const _accountsPerPage = 10;
window.renderAccountsTable = renderAccountsTable;

async function renderAccounts() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="acc-page">
      <div class="acc-topbar">
        <div>
          <div class="acc-topbar-title">Accounts</div>
          <div class="acc-topbar-sub">Dashboard &rsaquo; Accounts Table</div>
        </div>
        <div class="acc-topbar-actions">
          <button class="btn btn-primary" onclick="window.location.hash='import'" id="btn-acc-import">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
            Import CSV
          </button>
          <button class="btn btn-secondary" id="btn-acc-export">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
            Export Data
          </button>
          <button class="btn btn-primary" id="btn-auth-all" onclick="bulkAuthAllAccounts()" style="background:var(--green);border-color:var(--green);gap:6px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Auth All
          </button>
        </div>
      </div>

      <div id="acc-stats-row" class="acc-stats-row">
        <div class="loading-overlay" style="grid-column:1/-1"><div class="spinner"></div></div>
      </div>

      <div class="acc-toolbar">
        <div class="acc-search-wrap">
          <svg class="acc-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="acc-search" id="acc-search" placeholder="Filter & Search accounts..." />
        </div>
        <select class="form-select acc-filter-select" id="acc-filter-platform" style="width:140px">
          <option value="">All Platforms</option>
          <option value="XBL">Xbox</option>
          <option value="PSN">PlayStation</option>
        </select>
        <select class="form-select acc-filter-select" id="acc-filter-status" style="width:160px">
          <option value="">All Statuses</option>
          <option value="authenticated">Authenticated</option>
          <option value="manual_login_required">Manual Login</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
        <button class="btn btn-secondary" id="btn-acc-clear" style="padding:8px 12px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div id="bulk-actions-wrap" style="display:none;gap:6px;align-items:center;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--text-3);white-space:nowrap">Selected: <strong id="bulk-sel-count">0</strong></span>
          <button class="btn btn-primary" id="btn-bulk-create" style="background:var(--purple);gap:6px" onclick="bulkCreateTicketsForSelected()">
            🎫 Create
          </button>
          <button class="btn btn-secondary" id="btn-bulk-view" style="gap:4px" onclick="bulkViewSelected()">
            👁 View Tickets
          </button>
          <button class="btn btn-secondary" id="btn-bulk-delete" style="gap:4px;border-color:var(--red);color:var(--red)" onclick="bulkDeleteSelected()">
            🗑 Delete
          </button>
        </div>
      </div>

      <div id="accounts-list">
        <div class="loading-overlay"><div class="spinner"></div><span>Loading accounts...</span></div>
      </div>
    </div>`;

  const accounts = await api('/accounts');
  _accountsData = accounts;
  window._accountsPage = 1;

  // Stats
  const total = accounts.length;
  const auth = accounts.filter(a => a.login_status === 'authenticated').length;
  const manual = accounts.filter(a => a.login_status === 'manual_login_required').length;
  const failed = accounts.filter(a => a.login_status === 'failed').length;
  const xbox = accounts.filter(a => a.platform === 'XBL').length;
  const psn = accounts.filter(a => a.platform === 'PSN').length;

  document.getElementById('acc-stats-row').innerHTML = `
    <div class="acc-stat-card">
      <div class="acc-stat-icon" style="background:var(--blue-10);color:var(--blue)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </div>
      <div class="acc-stat-body">
        <div class="acc-stat-value">${total}</div>
        <div class="acc-stat-label">Total Accounts</div>
      </div>
      <div class="acc-stat-bar" style="--bar-color:var(--blue);--bar-pct:100%"></div>
    </div>
    <div class="acc-stat-card">
      <div class="acc-stat-icon" style="background:var(--green-10);color:var(--green)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="acc-stat-body">
        <div class="acc-stat-value" style="color:var(--green)">${auth}</div>
        <div class="acc-stat-label">Authenticated</div>
      </div>
      <div class="acc-stat-bar" style="--bar-color:var(--green);--bar-pct:${total ? Math.round(auth/total*100) : 0}%"></div>
    </div>
    <div class="acc-stat-card">
      <div class="acc-stat-icon" style="background:var(--orange-10);color:var(--orange)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      </div>
      <div class="acc-stat-body">
        <div class="acc-stat-value" style="color:var(--orange)">${manual}</div>
        <div class="acc-stat-label">Manual Login</div>
      </div>
      <div class="acc-stat-bar" style="--bar-color:var(--orange);--bar-pct:${total ? Math.round(manual/total*100) : 0}%"></div>
    </div>
    <div class="acc-stat-card">
      <div class="acc-stat-icon" style="background:var(--red-10);color:var(--red)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="acc-stat-body">
        <div class="acc-stat-value" style="color:var(--red)">${failed}</div>
        <div class="acc-stat-label">Failed</div>
      </div>
      <div class="acc-stat-bar" style="--bar-color:var(--red);--bar-pct:${total ? Math.round(failed/total*100) : 0}%"></div>
    </div>
    <div class="acc-stat-card">
      <div class="acc-stat-icon" style="background:var(--xbox-10);color:var(--xbox)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>
      </div>
      <div class="acc-stat-body">
        <div class="acc-stat-value" style="color:var(--xbox)">${xbox}</div>
        <div class="acc-stat-label">Xbox</div>
      </div>
      <div class="acc-stat-bar" style="--bar-color:var(--xbox);--bar-pct:${total ? Math.round(xbox/total*100) : 0}%"></div>
    </div>
    <div class="acc-stat-card">
      <div class="acc-stat-icon" style="background:var(--psn-10);color:var(--psn)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>
      </div>
      <div class="acc-stat-body">
        <div class="acc-stat-value" style="color:var(--psn)">${psn}</div>
        <div class="acc-stat-label">PlayStation</div>
      </div>
      <div class="acc-stat-bar" style="--bar-color:var(--psn);--bar-pct:${total ? Math.round(psn/total*100) : 0}%"></div>
    </div>`;

  renderAccountsTable();

  // Wire up controls
  document.getElementById('acc-search').addEventListener('input', () => { window._accountsPage = 1; renderAccountsTable(); });
  document.getElementById('acc-filter-platform').addEventListener('change', () => { window._accountsPage = 1; renderAccountsTable(); });
  document.getElementById('acc-filter-status').addEventListener('change', () => { window._accountsPage = 1; renderAccountsTable(); });
  document.getElementById('btn-acc-clear').addEventListener('click', () => {
    document.getElementById('acc-search').value = '';
    document.getElementById('acc-filter-platform').value = '';
    document.getElementById('acc-filter-status').value = '';
    window._accountsPage = 1;
    renderAccountsTable();
  });
  document.getElementById('btn-acc-export')?.addEventListener('click', () => {
    const csv = ['Account ID,Email,Platform,Status,Level,Date Linked',
      ..._accountsData.map(a => `${a.id},${a.login_email},${a.platform},${a.login_status},${a.account_level},${a.date_linked || ''}`)].join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv,' + encodeURIComponent(csv);
    a.download = 'accounts.csv';
    a.click();
  });
}

function renderAccountsTable() {
  const search = (document.getElementById('acc-search')?.value || '').toLowerCase();
  const platform = document.getElementById('acc-filter-platform')?.value || '';
  const status = document.getElementById('acc-filter-status')?.value || '';

  let filtered = _accountsData.filter(a => {
    if (platform && a.platform !== platform) return false;
    if (status && a.login_status !== status) return false;
    if (search && !a.username?.toLowerCase().includes(search) && !a.login_email?.toLowerCase().includes(search)) return false;
    return true;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / _accountsPerPage));
  if (window._accountsPage > pages) window._accountsPage = pages;
  const start = (window._accountsPage - 1) * _accountsPerPage;
  const slice = filtered.slice(start, start + _accountsPerPage);

  const container = document.getElementById('accounts-list');
  if (!container) return;

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">No accounts found</div><div class="empty-state-text">Try adjusting your search or filters.</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="acc-table-wrap">
      <div class="acc-count">${total} account${total !== 1 ? 's' : ''}</div>
      <div style="flex:1;overflow-y:auto">
      <table class="acc-table">
        <thead>
          <tr>
            <th style="width:36px;text-align:center"><input type="checkbox" id="acc-select-all" onchange="toggleSelectAll(this)" title="Select All" /></th>
            <th>Account ID</th>
            <th>User Email</th>
            <th>Platform</th>
            <th>Linked Account</th>
            <th>Status</th>
            <th>Last Active</th>
            <th style="text-align:right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${slice.map(a => {
            const initials = (a.username || '?').substring(0,2).toUpperCase();
            const avatarColor = a.platform === 'XBL' ? 'var(--xbox)' : 'var(--psn)';
            const avatarBg = a.platform === 'XBL' ? 'var(--xbox-10)' : 'var(--psn-10)';
            const linkedAcc = a.platform_login_email || a.date_linked || '-';
            const lastActive = a.updated_at ? formatDate(a.updated_at) : (a.date_linked ? a.date_linked : '-');
            return `
            <tr class="acc-row">
              <td style="text-align:center"><input type="checkbox" class="acc-select-cb" data-id="${a.id}" data-status="${a.login_status}" onchange="updateBulkSelection()" /></td>
              <td><span class="acc-id">#${a.id}</span></td>
              <td>
                <div class="acc-user-cell">
                  <div class="acc-avatar" style="background:${avatarBg};color:${avatarColor}">${initials}</div>
                  <div>
                    <div class="acc-username" style="display:flex;align-items:center;gap:6px">
                      ${a.username || '-'}
                      ${a.notes ? `<span title="${escapeHtml(a.notes)}" style="font-size:10px;cursor:pointer" onclick="showAccountDetail(${a.id})">📝</span>` : ''}
                    </div>
                    <div class="acc-email">${a.login_email}</div>
                  </div>
                </div>
              </td>
              <td>
                <div class="acc-platform-cell">
                  ${a.platform === 'XBL' ? `
                    <div class="acc-platform-icon xbox">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zM8.309 5.813C9.393 5.11 10.65 4.7 12 4.7c1.35 0 2.607.41 3.691 1.113C14.29 7.09 13.05 8.29 12 9.6c-1.05-1.31-2.29-2.51-3.691-3.787zM5.813 8.309C7.09 9.71 8.29 10.95 9.6 12c-1.31 1.05-2.51 2.29-3.787 3.691A7.283 7.283 0 0 1 4.7 12c0-1.35.41-2.607 1.113-3.691zm2.496 9.878C9.71 16.91 10.95 15.71 12 14.4c1.05 1.31 2.29 2.51 3.691 3.787A7.283 7.283 0 0 1 12 19.3a7.283 7.283 0 0 1-3.691-1.113zm9.878-2.496C16.91 14.29 15.71 13.05 14.4 12c1.31-1.05 2.51-2.29 3.787-3.691A7.283 7.283 0 0 1 19.3 12c0 1.35-.41 2.607-1.113 3.691z"/>
                      </svg>
                    </div>
                    <span style="color:var(--xbox);font-weight:700;font-size:12px;letter-spacing:.01em">Xbox</span>` : `
                    <div class="acc-platform-icon psn">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9.14 4.702v13.91l2.97 1.086V7.757c0-.536.24-.896.622-.75.49.183.585.682.585 1.218v4.203c1.344.647 2.35-.068 2.35-1.918 0-1.904-.66-2.823-2.578-3.52C11.56 6.4 10.155 5.98 9.14 4.702zm7.486 9.231c-.813.42-1.68.526-2.47.24v1.343c.64.198 1.37.218 2.173-.099 1.712-.683 2.17-2.247 2.17-2.247l-1.873.763zm-8.632 3.044c-.813-.2-1.19-.678-1.19-1.283 0-.81.578-1.322 1.437-1.51l2.603-.73v1.336L8.614 15.6c-.372.103-.546.295-.546.524 0 .296.217.476.547.554l1.843.389v1.33l-2.849-.368v-.052z"/>
                      </svg>
                    </div>
                    <span style="color:var(--psn);font-weight:700;font-size:12px;letter-spacing:.01em">PSN</span>`}
                </div>
              </td>

              <td><span class="acc-linked">${linkedAcc}</span></td>
              <td><span class="acc-status-badge acc-status-${a.login_status}">${formatLoginStatus(a.login_status)}</span></td>
              <td class="acc-last-active">${lastActive}</td>
              <td>
                <div class="acc-actions">
                  <button class="acc-btn-icon ${a.notes ? 'acc-btn-purple' : ''}" title="${a.notes ? 'Notes: ' + escapeHtml(a.notes) : 'Add Notes'}" onclick="showAccountDetail(${a.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </button>
                  <button class="acc-btn-icon acc-btn-blue" title="Open Profile & Ticket on Ubisoft" onclick="openUbisoftProfile(${a.id})" style="color:#60a5fa">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                  ${a.login_status === 'authenticated' ? `<button class="acc-btn-icon acc-btn-blue" title="Create Ticket" onclick="createTicketAction(${a.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5v2"/><path d="M15 11v2"/><path d="M15 17v2"/><path d="M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2z"/></svg>
                  </button>` : ''}
                  ${a.login_status !== 'authenticated' ? `<button class="acc-btn-icon acc-btn-orange" title="Auto Login" onclick="retryLoginAction(${a.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  </button>` : ''}
                  <button class="acc-btn-icon acc-btn-red" title="Delete" onclick="deleteAccountById(${a.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                  </button>
                </div>
              </td>
            </tr>`;

          }).join('')}
        </tbody>
      </table>
      </div>

      <div class="acc-pagination">
        <span class="acc-page-info">${start + 1}–${Math.min(start + _accountsPerPage, total)} of ${total}</span>
        <div class="acc-page-controls">
          <button class="acc-page-btn" ${window._accountsPage <= 1 ? 'disabled' : ''} onclick="window._accountsPage--;renderAccountsTable()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          ${Array.from({length: pages}, (_, i) => i + 1)
            .filter(p => p === 1 || p === pages || Math.abs(p - window._accountsPage) <= 1)
            .reduce((acc, p, i, arr) => {
              if (i > 0 && p - arr[i-1] > 1) acc.push('...');
              acc.push(p);
              return acc;
            }, [])
            .map(p => p === '...'
              ? `<span class="acc-page-ellipsis">···</span>`
              : `<button class="acc-page-btn ${p === window._accountsPage ? 'active' : ''}" onclick="window._accountsPage=${p};renderAccountsTable()">${p}</button>`
            ).join('')}
          <button class="acc-page-btn" ${window._accountsPage >= pages ? 'disabled' : ''} onclick="window._accountsPage++;renderAccountsTable()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
    </div>`;
}

// Import Page

function renderImport() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="content-header">
      <div><div class="content-title">📥 Import CSV</div>
      <div class="content-subtitle">Upload account data from CSV files</div></div>
    </div>
    <div class="content-body">
      <div class="card mb-4"><div class="card-header"><div class="card-title">File Upload</div></div><div class="card-body">
        <div class="upload-zone" id="upload-zone">
          <div class="upload-zone-icon">📁</div>
          <div class="upload-zone-text">Drop CSV file here or click to browse</div>
          <div class="upload-zone-hint">Supports Xbox and PlayStation formats (including mixed)</div>
          <input type="file" id="csv-file-input" accept=".csv" style="display:none" />
        </div>
      </div></div>

      <div class="card mb-4"><div class="card-header"><div class="card-title">Paste CSV Text</div></div><div class="card-body">
        <div class="form-group">
          <textarea class="form-textarea" id="csv-text-input" rows="6" placeholder="Paste CSV content here..."></textarea>
        </div>
      </div></div>

      <div class="card mb-4"><div class="card-header"><div class="card-title">Options</div></div><div class="card-body">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text-1)">
          <input type="checkbox" id="auto-create-tickets" style="width:18px;height:18px;accent-color:var(--blue)" />
          <span>Auto-create tickets after import (parse -> login -> create tickets automatically)</span>
        </label>
      </div></div>

      <button class="btn btn-primary btn-lg" id="btn-import-text" style="width:100%">🚀 Import from Text</button>

      <div id="import-results" class="import-results"></div>
    </div>`;

  const zone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('csv-file-input');

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFileUpload(fileInput.files[0]); });

  document.getElementById('btn-import-text').addEventListener('click', async () => {
    const text = document.getElementById('csv-text-input').value.trim();
    if (!text) { showToast('Please paste CSV content', 'warning'); return; }
    const autoCreate = document.getElementById('auto-create-tickets')?.checked;
    showToast('Importing accounts...', 'info');
    const result = await api('/import/csv-text', { method: 'POST', body: JSON.stringify({ csvContent: text, autoCreateTickets: autoCreate }) });
    showImportResults(result);
  });
}

async function handleFileUpload(file) {
  if (!file.name.endsWith('.csv')) { showToast('Please select a CSV file', 'error'); return; }

  const formData = new FormData();
  formData.append('csvFile', file);
  const autoCreate = document.getElementById('auto-create-tickets')?.checked;
  if (autoCreate) formData.append('autoCreateTickets', 'true');

  showToast(`Importing ${file.name}...`, 'info');

  const res = await fetch('/api/import/csv', { method: 'POST', body: formData });
  const result = await res.json();
  showImportResults(result);
}

function showImportResults(result) {
  const container = document.getElementById('import-results');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="import-result-item error">❌ Error: ${result.error}</div>`;
    showToast(result.error, 'error');
    return;
  }

  showToast(`Imported ${result.imported} accounts (${result.errors} errors)`, result.errors ? 'warning' : 'success');

  let html = `<h3 style="margin:16px 0 8px;color:var(--text-0)">Import Results</h3>`;
  html += `<div class="import-result-item success">✅ Successfully imported: ${result.imported}</div>`;

  if (result.loginResults?.length) {
    html += `<h4 style="margin:12px 0 6px;color:var(--text-2);font-size:12px">Login Results:</h4>`;
    for (const lr of result.loginResults) {
      const cls = lr.status === 'authenticated' ? 'success' : 'error';
      html += `<div class="import-result-item ${cls}">${lr.status === 'authenticated' ? '✅' : '⚠️'} ${lr.username}: ${lr.status}${lr.reason ? ` (${lr.reason})` : ''}</div>`;
    }
  }

  if (result.parseErrors?.length) {
    html += `<h4 style="margin:12px 0 6px;color:var(--text-2);font-size:12px">Parse Errors:</h4>`;
    for (const pe of result.parseErrors) {
      html += `<div class="import-result-item error">❌ Line ${pe.line}: ${pe.reason}</div>`;
    }
  }

  container.innerHTML = html;
}

// Stats Page
async function renderStats() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="content-header">
      <div><div class="content-title">📈 Statistics</div>
      <div class="content-subtitle">Weekly ticket completion overview</div></div>
    </div>
    <div class="content-body">
      <div class="filter-bar mb-4">
        <select class="form-select" id="stats-month">
          <option value="">All Months</option>
          ${[...Array(12)].map((_, i) => `<option value="${i+1}">${new Date(2026, i).toLocaleString('en',{month:'long'})}</option>`).join('')}
        </select>
        <select class="form-select" id="stats-year">
          <option value="2026">2026</option><option value="2025">2025</option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card"><div class="card-header"><div class="card-title">Ticket Activity Chart</div></div><div class="card-body" style="padding:16px"><canvas id="stats-chart" height="320"></canvas></div></div>
        <div>
          <div class="card mb-4"><div class="card-header"><div class="card-title">Legend</div></div><div class="card-body">
            <div style="display:flex;gap:24px;align-items:center;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:8px"><div style="width:14px;height:14px;border-radius:3px;background:linear-gradient(135deg,#22c55e,#15803d)"></div><span style="font-size:13px;color:var(--text-1)">Xbox (XBL)</span></div>
              <div style="display:flex;align-items:center;gap:8px"><div style="width:14px;height:14px;border-radius:3px;background:linear-gradient(135deg,#3b82f6,#1d4ed8)"></div><span style="font-size:13px;color:var(--text-1)">PlayStation (PSN)</span></div>
            </div>
            <div style="font-size:12px;color:var(--text-3)">Bars show stacked ticket counts per week. Xbox is on top, PSN on bottom.</div>
          </div></div>
          <div class="card"><div class="card-header"><div class="card-title">Summary</div></div><div class="card-body">
            <div id="stats-summary" style="display:grid;grid-template-columns:1fr 1fr;gap:12px"></div>
          </div></div>
        </div>
      </div>
    </div>`;

  await loadStats();
  document.getElementById('stats-month').addEventListener('change', loadStats);
  document.getElementById('stats-year').addEventListener('change', loadStats);
}

async function loadStats() {
  const month = document.getElementById('stats-month')?.value || '';
  const year = document.getElementById('stats-year')?.value || '2026';

  let url = `/stats/weekly?year=${year}`;
  if (month) url += `&month=${month}`;

  const stats = await api(url);
  drawBarChart(stats);

  // Summary
  let totalXbox = 0, totalPSN = 0;
  for (const s of stats) { if (s.platform === 'XBL') totalXbox += s.count; else totalPSN += s.count; }
  const summaryEl = document.getElementById('stats-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="stat-card xbox" style="padding:12px"><div class="stat-label">Xbox Total</div><div class="stat-value" style="font-size:22px">${totalXbox}</div></div>
      <div class="stat-card psn" style="padding:12px"><div class="stat-label">PSN Total</div><div class="stat-value" style="font-size:22px">${totalPSN}</div></div>
      <div class="stat-card info" style="padding:12px"><div class="stat-label">Combined</div><div class="stat-value" style="font-size:22px">${totalXbox + totalPSN}</div></div>
      <div class="stat-card" style="padding:12px"><div class="stat-label">Weeks Active</div><div class="stat-value" style="font-size:22px">${new Set(stats.map(s => s.week_number)).size}</div></div>
    `;
  }
}

function drawBarChart(stats) {
  const canvas = document.getElementById('stats-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = 320 * dpr;
  ctx.scale(dpr, dpr);
  const W = canvas.offsetWidth, H = 320;
  ctx.clearRect(0, 0, W, H);

  if (!stats.length) {
    // decorative empty grid
    for (let i = 0; i <= 4; i++) {
      const y = 20 + (H - 48) * (1 - i / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(W - 16, y); ctx.stroke();
    }
    const ghostW = Math.min(28, (W - 80) / 8);
    for (let i = 0; i < 8; i++) {
      const x = 44 + i * ((W - 80) / 8);
      const h = 20 + Math.random() * 60;
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.beginPath();
      ctx.roundRect(x, H - 32 - h, ghostW, h, 3);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.font = '500 12px Geist, system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Waiting for ticket data', W / 2, H / 2 - 6);
    ctx.font = '400 10px Geist, system-ui';
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillText('Activity will populate this chart', W / 2, H / 2 + 12);
    return;
  }

  const weekMap = {};
  for (const s of stats) {
    const key = `W${s.week_number}`;
    if (!weekMap[key]) weekMap[key] = { xbox: 0, psn: 0 };
    if (s.platform === 'XBL') weekMap[key].xbox += s.count;
    else weekMap[key].psn += s.count;
  }

  const weeks = Object.keys(weekMap);
  const maxVal = Math.max(...weeks.map(w => weekMap[w].xbox + weekMap[w].psn), 1);
  const gap = 10;
  const barW = Math.min(48, (W - 80) / weeks.length - gap);
  const chartH = H - 60;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.fillStyle = '#4a5568';
  ctx.font = '10px Inter';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 5; i++) {
    const val = Math.round((maxVal / 5) * i);
    const y = H - 30 - (i / 5) * chartH;
    ctx.fillText(val.toString(), 48, y + 3);
    ctx.beginPath(); ctx.moveTo(55, y); ctx.lineTo(W - 10, y); ctx.stroke();
  }

  weeks.forEach((week, i) => {
    const x = 60 + i * (barW + gap);
    const xboxH = (weekMap[week].xbox / maxVal) * chartH;
    const psnH = (weekMap[week].psn / maxVal) * chartH;

    // PSN bar
    const grad1 = ctx.createLinearGradient(x, H - 30 - psnH - xboxH, x, H - 30);
    grad1.addColorStop(0, '#3b82f6'); grad1.addColorStop(1, '#1d4ed8');
    ctx.fillStyle = grad1;
    ctx.beginPath(); ctx.roundRect(x, H - 30 - psnH - xboxH, barW, psnH, [6, 6, 0, 0]); ctx.fill();

    // Xbox bar
    const grad2 = ctx.createLinearGradient(x, H - 30 - xboxH, x, H - 30);
    grad2.addColorStop(0, '#22c55e'); grad2.addColorStop(1, '#15803d');
    ctx.fillStyle = grad2;
    ctx.beginPath(); ctx.roundRect(x, H - 30 - xboxH, barW, xboxH, [0, 0, 6, 6]); ctx.fill();

    // Value on top
    const total = weekMap[week].xbox + weekMap[week].psn;
    if (total > 0) {
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 11px Inter';
      ctx.textAlign = 'center';
      ctx.fillText(total.toString(), x + barW / 2, H - 34 - psnH - xboxH);
    }

    // Week label
    ctx.fillStyle = '#6b7a94';
    ctx.font = '10px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(week, x + barW / 2, H - 10);
  });
}

// Failed Accounts Page
async function renderFailed() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="content-header">
      <div><div class="content-title">⚠️ Failed Accounts</div>
      <div class="content-subtitle">Accounts that could not be logged in</div></div>
    </div>
    <div class="content-body">
      <div id="failed-list"><div class="loading-overlay"><div class="spinner"></div></div></div>
    </div>`;

  const { accounts, count } = await api('/failed-accounts');
  const container = document.getElementById('failed-list');

  if (!accounts.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-title">No failed accounts</div><div class="empty-state-text">All accounts authenticated successfully.</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="stats-grid mb-4" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat-card danger"><div class="stat-icon">❌</div><div class="stat-label">Total Failed</div><div class="stat-value">${count}</div></div>
      <div class="stat-card warning"><div class="stat-icon">🔄</div><div class="stat-label">Retryable</div><div class="stat-value">${accounts.filter(a => a.failure_reason?.includes('captcha') || a.failure_reason?.includes('timeout')).length}</div></div>
      <div class="stat-card"><div class="stat-icon">📋</div><div class="stat-label">CSV Lines</div><div class="stat-value">${accounts.length}</div></div>
    </div>
    <div class="card">
      <table class="data-table">
        <thead><tr><th>Username</th><th>Failure Reason</th><th>Date</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>
          ${accounts.map(a => `
            <tr>
              <td><div class="account-username">${a.username || 'Unknown'}</div><div class="text-sm text-muted">CSV Line ${a.csv_line}</div></td>
              <td><span class="badge badge-failed">${a.failure_reason}</span></td>
              <td class="text-sm text-muted">${formatDate(a.created_at)}</td>
              <td class="text-right"><button class="btn btn-sm btn-danger" onclick="deleteFailedById(${a.id})">✕ Remove</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

// Settings Page
async function renderSettings() {
  const main = document.getElementById('main-content');
  const settings = await api('/settings');

  const maskKey = (k) => k ? k.slice(0, 8) + '…' + k.slice(-6) : '';
  const hasKey  = (k) => k && k.length > 4;
  const curProvider = settings.ai_provider || 'yunwu';
  const curModel    = settings.ai_model    || 'deepseek-v4-flash:floor';

  const AI_PROVIDERS = [
    { id:'yunwu',      flag:'🇨🇳', name:'Yunwu.ai \u2192 DeepSeek',       sub:'yunwu.ai \u00b7 China',          tag:'Active',  color:'#8b5cf6' },
  ];
  const aiProvidersHtml = AI_PROVIDERS.map(p => {
    const active = curProvider === p.id ? ' active' : '';
    return '<div class="ai-provider-card' + active + '" data-provider="' + p.id + '" onclick="selectAiProvider(\'' + p.id + '\')" style="--pc:' + p.color + '">'
      + '<div class="ai-provider-flag">' + p.flag + '</div>'
      + '<div class="ai-provider-info"><div class="ai-provider-name">' + p.name + '</div><div class="ai-provider-sub">' + p.sub + '</div></div>'
      + '<span class="ai-provider-tag">' + p.tag + '</span>'
      + '</div>';
  }).join('');

  main.innerHTML = `
    <div class="cfg-page">

      <!-- -- Header -- -->
      <div class="cfg-header">
        <div>
          <div class="cfg-title">System Configuration</div>
          <div class="cfg-subtitle">Manage technical parameters, access controls, and operational thresholds.</div>
        </div>
        <button class="btn btn-primary" id="btn-save-settings" style="gap:7px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save Configuration
        </button>
      </div>

      <!-- -- Row 1: API Keys + Proxy Nodes -- -->
      <div class="cfg-grid-2">

        <!-- API Keys -->
        <div class="cfg-card">
          <div class="cfg-card-head">
            <div class="cfg-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
              API Keys
            </div>
            <button class="cfg-action-btn" id="btn-check-captcha">Check Balance</button>
          </div>
          <div class="cfg-card-body" style="display:flex;flex-direction:column;gap:10px">

            <!-- 2Captcha / Rucaptcha -->
            <div class="cfg-key-card">
              <div class="cfg-key-header">
                <div>
                  <div class="cfg-key-name">2CAPTCHA / RUCAPTCHA</div>
                  <div class="cfg-key-val" id="capsolver-masked">${hasKey(settings.captcha_api_key) ? maskKey(settings.captcha_api_key) : 'Not configured'}</div>
                </div>
                <span class="cfg-badge ${hasKey(settings.captcha_api_key) ? 'cfg-badge-active' : 'cfg-badge-revoked'}" id="capsolver-badge">
                  ${hasKey(settings.captcha_api_key) ? '● ACTIVE' : '● MISSING'}
                </span>
              </div>
              <div style="display:flex;gap:8px;margin-top:10px">
                <input class="cfg-input" id="set-captcha-key" value="${settings.captcha_api_key || ''}" placeholder="2Captcha API key…" style="flex:1" />
                <button class="cfg-icon-btn" title="Copy" onclick="navigator.clipboard.writeText(document.getElementById('set-captcha-key').value)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>
              <div class="cfg-balance-row" id="capsolver-balance-row" style="display:none"></div>
            </div>

            <!-- AI Configuration - Full TZ compliant -->
            <div class="cfg-key-card" style="padding:0;overflow:hidden">
              <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <div>
                    <div class="cfg-key-name">AI REPLY ASSISTANT</div>
                    <div class="cfg-key-val" style="margin-top:2px">${hasKey(settings.ai_api_key) ? maskKey(settings.ai_api_key) : 'Not configured'}</div>
                  </div>
                  <div style="display:flex;gap:6px;align-items:center">
                    <span class="cfg-badge ${hasKey(settings.ai_api_key) ? 'cfg-badge-active' : 'cfg-badge-revoked'}">
                      ${hasKey(settings.ai_api_key) ? '● ACTIVE' : '● MISSING'}
                    </span>
                    <button class="cfg-action-btn" id="btn-test-ai">Test</button>
                  </div>
                </div>
              </div>

              <!-- Provider picker -->
              <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
                <label class="cfg-label" style="margin-bottom:8px">Provider (Non-Western only, per spec)</label>
                <div class="ai-provider-grid" id="ai-provider-grid">
                  ${aiProvidersHtml}
                </div>
              </div>

              <!-- API Key -->
              <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
                <label class="cfg-label" style="margin-bottom:5px">API Key</label>
                <div style="display:flex;gap:8px">
                  <input class="cfg-input" id="set-ai-key" value="${settings.ai_api_key || ''}"
                    placeholder="sk-or-v1-… / sk-… / your-key"
                    type="password" style="flex:1" />
                  <button class="cfg-icon-btn" title="Toggle visibility" id="btn-ai-key-eye"
                    onclick="const i=document.getElementById('set-ai-key');i.type=i.type==='password'?'text':'password'">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                  <button class="cfg-icon-btn" title="Copy" onclick="navigator.clipboard.writeText(document.getElementById('set-ai-key').value)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                </div>
              </div>

              <!-- Model selector -->
              <div style="padding:12px 14px">
                <label class="cfg-label" style="margin-bottom:5px">Model</label>
                <select class="cfg-input" id="set-ai-model" style="cursor:pointer">
                  <optgroup label="🇨🇳 Yunwu.ai (China - Crypto)">
                    <option value="deepseek-v4-flash:floor" ${curModel==='deepseek-v4-flash:floor'?'selected':''}>DeepSeek V4 Flash - Fast & cheap</option>
                    <option value="deepseek-chat" ${curModel==='deepseek-chat'?'selected':''}>DeepSeek Chat - General purpose</option>
                    <option value="deepseek-reasoner" ${curModel==='deepseek-reasoner'?'selected':''}>DeepSeek Reasoner - Reasoning</option>
                  </optgroup>
                  <optgroup label="🇨🇳 DeepSeek Direct (China)">
                    <option value="deepseek/deepseek-chat-v3-0324" ${curModel==='deepseek/deepseek-chat-v3-0324'?'selected':''}>DeepSeek Chat V3 - Best for replies</option>
                    <option value="deepseek/deepseek-r1" ${curModel==='deepseek/deepseek-r1'?'selected':''}>DeepSeek R1 - Reasoning (slower)</option>
                  </optgroup>
                  <optgroup label="🇨🇳 Qwen / Alibaba (China)">
                    <option value="qwen/qwen3-235b-a22b" ${curModel==='qwen/qwen3-235b-a22b'?'selected':''}>Qwen3 235B - Ultra powerful</option>
                    <option value="qwen/qwen-turbo" ${curModel==='qwen/qwen-turbo'?'selected':''}>Qwen Turbo - Fast, cheap</option>
                  </optgroup>
                  <optgroup label="🇷🇺 Yandex (Russia)">
                    <option value="yandexgpt-lite" ${curModel==='yandexgpt-lite'?'selected':''}>YandexGPT Lite - Russian-hosted</option>
                    <option value="yandexgpt" ${curModel==='yandexgpt'?'selected':''}>YandexGPT Pro</option>
                  </optgroup>
                  <optgroup label="⚙️ Custom">
                    <option value="custom">Custom model ID…</option>
                  </optgroup>
                </select>
                <div id="custom-model-wrap" style="display:none;margin-top:8px">
                  <input class="cfg-input" id="set-ai-model-custom" placeholder="provider/model-id" />
                </div>
                <div class="ai-model-note">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Per spec: AI provider must not be US/EU-based. All listed models meet this requirement. Payments via crypto accepted by all providers.
                </div>
              </div>

              <div id="ai-test-result" style="display:none;padding:10px 14px;border-top:1px solid var(--border);font-size:12px"></div>
            </div>


          </div>
        </div>

        <!-- Proxy Nodes -->
        <div class="cfg-card">
          <div class="cfg-card-head">
            <div class="cfg-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              Proxy Pool
            </div>
            <div style="display:flex;gap:6px">
              <button class="cfg-action-btn" id="btn-test-proxies">Test All</button>
            </div>
          </div>
          <div class="cfg-card-body">
            <!-- Proxy file upload -->
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
              <div>
                <label class="cfg-label">Proxy List (.txt - one per line, format: user:pass@host:port)</label>
                <div style="display:flex;gap:8px;margin-top:5px">
                  <textarea class="cfg-input" id="set-proxy-list" rows="4"
                    style="flex:1;font-family:monospace;font-size:11px;resize:vertical;line-height:1.6"
                    placeholder="user:pass@host:port&#10;user2:pass2@host2:port2&#10;...">${settings.proxy_list || (settings.proxy_us ? settings.proxy_us + '\n' + (settings.proxy_global || '') : '')}</textarea>
                </div>
                <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
                  <label class="btn btn-secondary" style="padding:6px 12px;cursor:pointer;font-size:11px">
                    📂 Load from .txt
                    <input type="file" accept=".txt" id="proxy-file-input" style="display:none" />
                  </label>
                  <span style="font-size:12px;color:var(--text-2)" id="proxy-count-label">
                    📊 <strong id="proxy-count-num">${((settings.proxy_list || settings.proxy_us || '').split('\n').filter(l => l.trim()).length)}</strong> proxies loaded
                  </span>
                  <button class="btn btn-secondary" style="padding:6px 10px;font-size:11px" onclick="updateProxyCount()">🔄 Count</button>
                </div>
              </div>
            </div>
            <!-- Proxy test results -->
            <div id="proxy-test-results" style="display:none;margin-top:8px">
              <table class="cfg-proxy-table">
                <thead>
                  <tr><th>PROXY</th><th>LATENCY</th><th>STATUS</th></tr>
                </thead>
                <tbody id="proxy-test-body"></tbody>
              </table>
            </div>
            <div style="margin-top:10px">
              <label class="cfg-label">CamoFox Binary Path</label>
              <input class="cfg-input" id="set-camofox-path" value="${settings.camofox_path || 'camofox'}" placeholder="/usr/bin/camofox" />
            </div>
          </div>
        </div>
      </div>

      <!-- -- Row 2: Automation Thresholds + Alert Preferences -- -->
      <div class="cfg-grid-2">

        <!-- Automation Thresholds -->
        <div class="cfg-card">
          <div class="cfg-card-head">
            <div class="cfg-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
              Automation Thresholds
            </div>
          </div>
          <div class="cfg-card-body" style="display:flex;flex-direction:column;gap:20px">

            <div class="cfg-slider-group">
              <div class="cfg-slider-header">
                <span class="cfg-slider-label">TOKEN REFRESH INTERVAL</span>
                <span class="cfg-slider-val" id="val-token-refresh">${settings.token_refresh_minutes || 50} min</span>
              </div>
              <input type="range" class="cfg-slider" id="set-token-refresh" min="10" max="55" step="5"
                value="${settings.token_refresh_minutes || 50}"
                oninput="document.getElementById('val-token-refresh').textContent=this.value+' min'" />
              <div class="cfg-slider-ticks"><span>10</span><span>30</span><span>55</span></div>
            </div>

            <div class="cfg-slider-group">
              <div class="cfg-slider-header">
                <span class="cfg-slider-label">TICKET POLL INTERVAL</span>
                <span class="cfg-slider-val" id="val-poll-interval">${settings.poll_interval_seconds || 45} sec</span>
              </div>
              <input type="range" class="cfg-slider" id="set-poll-interval" min="15" max="120" step="15"
                value="${settings.poll_interval_seconds || 45}"
                oninput="document.getElementById('val-poll-interval').textContent=this.value+' sec'" />
              <div class="cfg-slider-ticks"><span>15s</span><span>60s</span><span>120s</span></div>
            </div>

            <div class="cfg-slider-group">
              <div class="cfg-slider-header">
                <span class="cfg-slider-label">LOGIN RETRY ATTEMPTS</span>
                <span class="cfg-slider-val" id="val-retry">3 attempts</span>
              </div>
              <input type="range" class="cfg-slider" id="cfg-retry" min="1" max="5" step="1" value="3"
                oninput="document.getElementById('val-retry').textContent=this.value+' attempts'" />
              <div class="cfg-slider-ticks"><span>1</span><span>3</span><span>5</span></div>
            </div>

            <div class="cfg-slider-group">
              <div class="cfg-slider-header">
                <span class="cfg-slider-label">CONCURRENCY THREADS</span>
                <span class="cfg-slider-val" id="val-threads">${settings.concurrency_threads || 3} threads</span>
              </div>
              <input type="range" class="cfg-slider" id="set-threads" min="1" max="10" step="1"
                value="${settings.concurrency_threads || 3}"
                oninput="document.getElementById('val-threads').textContent=this.value+' threads'" />
              <div class="cfg-slider-ticks"><span>1</span><span>5</span><span>10</span></div>
              <div style="margin-top:6px;font-size:11px;color:var(--text-3);line-height:1.4">
                Parallel ticket creation streams. Higher = faster bulk creation, but increases ban risk.
              </div>
            </div>

          </div>
        </div>

        <!-- Alert Preferences -->
        <div class="cfg-card">
          <div class="cfg-card-head">
            <div class="cfg-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              Alert Preferences
            </div>
          </div>
          <div class="cfg-card-body" style="display:flex;flex-direction:column;gap:6px">

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Agent Replies</div>
                <div class="cfg-toggle-sub">Sound + browser notification when Ubisoft agent replies</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="alert-agent-reply" checked />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Token Expiry Warnings</div>
                <div class="cfg-toggle-sub">Alert when a token refresh fails or expires</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="alert-token-expiry" checked />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Login Failures</div>
                <div class="cfg-toggle-sub">Notify when account auto-login fails after all retries</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="alert-login-fail" checked />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Ticket Closed by Agent</div>
                <div class="cfg-toggle-sub">Alert when Ubisoft support closes a ticket unexpectedly</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="alert-ticket-closed" checked />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Captcha Balance Low</div>
                <div class="cfg-toggle-sub">Warn when Capsolver balance drops below $1.00</div>
              </div>
              <label class="cfg-toggle">
           <!-- Captcha -->
        <div class="cfg-card">
          <div class="cfg-card-head">
            <div class="cfg-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Captcha Configuration
            </div>
          </div>
          <div class="cfg-card-body" style="display:flex;flex-direction:column;gap:6px">

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Chrome CDP (Primary)</div>
                <div class="cfg-toggle-sub">Solve reCAPTCHA in real Chrome via CDP - most reliable method</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="set-cdp-enabled" ${(settings.cdp_enabled || '1') === '1' ? 'checked' : ''} />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">2Captcha API (Fallback)</div>
                <div class="cfg-toggle-sub">Use 2Captcha/Capsolver when Chrome CDP fails or is disabled</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="set-2captcha-enabled" ${(settings.twocaptcha_enabled || '1') === '1' ? 'checked' : ''} />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Camoufox Browser (Legacy)</div>
                <div class="cfg-toggle-sub">Stealth Firefox fallback - slower but avoids Chrome fingerprinting</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="set-camoufox-enabled" ${(settings.camoufox_enabled || '0') === '1' ? 'checked' : ''} />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div class="cfg-toggle-row">
              <div>
                <div class="cfg-toggle-label">Datadome Captcha (Login)</div>
                <div class="cfg-toggle-sub">Solve geo.captcha-delivery.com during account login. Depends on App ID.</div>
              </div>
              <label class="cfg-toggle">
                <input type="checkbox" id="set-datadome-enabled" ${(settings.datadome_enabled || '1') === '1' ? 'checked' : ''} />
                <span class="cfg-toggle-track"></span>
              </label>
            </div>

            <div class="cfg-toggle-divider"></div>

            <div style="padding:8px 0">
              <label class="cfg-label" style="margin-bottom:5px">Login App ID</label>
              <select class="cfg-input" id="set-login-appid" style="cursor:pointer;font-size:12px">
                <option value="e3d5ea9e-50bd-43b7-88bf-39794f4e3d40" ${(settings.login_app_id || '') === 'e3d5ea9e-50bd-43b7-88bf-39794f4e3d40' ? 'selected' : ''}>Default (e3d5ea9e) - No Datadome</option>
                <option value="b8fde481-327d-4031-85ce-7c10c3a232e6" ${(settings.login_app_id || '') === 'b8fde481-327d-4031-85ce-7c10c3a232e6' ? 'selected' : ''}>Ticket App (b8fde481) - May trigger Datadome</option>
                <option value="custom_appid">Custom App ID</option>
              </select>
              <div id="custom-appid-wrap" style="display:none;margin-top:8px">
                <input class="cfg-input" id="set-login-appid-custom" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${settings.login_app_id_custom || ''}" />
              </div>
            </div>

          </div>
        </div>

      </div>

    </div>`;

  // -- Save --
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    // Custom App ID handling
    const appIdSelect = document.getElementById('set-login-appid')?.value;
    const appIdCustom = document.getElementById('set-login-appid-custom')?.value || '';
    const loginAppId = appIdSelect === 'custom_appid' ? appIdCustom : (appIdSelect || '');

    // Extract proxy list and back-fill proxy_us/proxy_global for pipeline compat
    const proxyListRaw = document.getElementById('set-proxy-list')?.value || '';
    const proxyLines = proxyListRaw.split('\n').map(l => l.trim()).filter(Boolean);
    const proxyUs = proxyLines[0] || '';
    const proxyGlobal = proxyLines[1] || proxyLines[0] || '';

    // Get selected AI provider from the active card
    const activeProviderCard = document.querySelector('.ai-provider-card.active');
    const selectedProvider = activeProviderCard?.dataset.provider
      || document.getElementById('set-ai-provider-hidden')?.value
      || 'yunwu';

    const pairs = [
      ['proxy_list',           proxyListRaw],
      ['proxy_us',             proxyUs],
      ['proxy_global',         proxyGlobal],
      ['captcha_api_key',      document.getElementById('set-captcha-key').value],
      ['poll_interval_seconds',document.getElementById('set-poll-interval').value],
      ['token_refresh_minutes',document.getElementById('set-token-refresh').value],
      ['ai_api_key',           document.getElementById('set-ai-key').value],
      ['ai_model',             document.getElementById('set-ai-model').value],
      ['ai_provider',          selectedProvider],
      ['camofox_path',         document.getElementById('set-camofox-path').value],
      ['concurrency_threads',  document.getElementById('set-threads').value],
      ['datadome_enabled',     document.getElementById('set-datadome-enabled')?.checked ? '1' : '0'],
      ['cdp_enabled',          document.getElementById('set-cdp-enabled')?.checked ? '1' : '0'],
      ['twocaptcha_enabled',   document.getElementById('set-2captcha-enabled')?.checked ? '1' : '0'],
      ['camoufox_enabled',     document.getElementById('set-camoufox-enabled')?.checked ? '1' : '0'],
      ['login_app_id',         loginAppId],
      ['login_app_id_custom',  appIdCustom],
    ];
    for (const [key, value] of pairs) {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ key, value }) });
    }
    showToast('Configuration saved', 'success');
    // Re-render to refresh masked values
    renderSettings();
  });

  // -- Check 2Captcha Balance --
  document.getElementById('btn-check-captcha').addEventListener('click', async () => {
    const btn = document.getElementById('btn-check-captcha');
    btn.textContent = 'Checking…';
    const result = await api('/captcha/balance');
    btn.textContent = 'Check Balance';
    const row = document.getElementById('capsolver-balance-row');
    if (result.success) {
      row.style.display = 'flex';
      row.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Balance: <strong style="color:var(--green)">$${result.balance.toFixed(3)}</strong>`;
      showToast(`2Captcha balance: $${result.balance.toFixed(3)}`, 'success');
    } else {
      row.style.display = 'flex';
      row.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> <span style="color:var(--red)">${result.error}</span>`;
      showToast(`Balance check failed: ${result.error}`, 'error');
    }
  });

  // -- Test Proxies (real check from textarea list) --
  document.getElementById('btn-test-proxies').addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-proxies');
    btn.textContent = 'Testing…';
    btn.disabled = true;

    const proxyListRaw = document.getElementById('set-proxy-list')?.value || '';
    const proxies = proxyListRaw.split('\n').map(l => l.trim()).filter(Boolean);

    if (!proxies.length) {
      showToast('No proxies to test', 'warning');
      btn.textContent = 'Test All';
      btn.disabled = false;
      return;
    }

    const tbody = document.getElementById('proxy-test-body');
    const table = document.getElementById('proxy-test-results');
    if (table) table.style.display = 'block';
    if (tbody) tbody.innerHTML = proxies.map(p => `<tr id="prow-${btoa(p).slice(0,8)}"><td style="font-family:monospace;font-size:11px">${p.replace(/(:[^:@]+)@/, ':***@')}</td><td id="plat-${btoa(p).slice(0,8)}">-</td><td><span class="cfg-status-badge" style="background:rgba(255,255,255,.05)">● CHECKING</span></td></tr>`).join('');

    let ok = 0, fail = 0;
    // Test up to 20 proxies max to avoid hanging
    const toTest = proxies.slice(0, 20);
    for (const proxy of toTest) {
      const key = btoa(proxy).slice(0, 8);
      const latEl = document.getElementById(`plat-${key}`);
      const row = document.getElementById(`prow-${key}`);
      const statusCell = row?.querySelector('td:last-child');
      const t0 = Date.now();
      try {
        const res = await fetch(`/api/proxy/check`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ proxy }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        const lat = Date.now() - t0;
        if (latEl) latEl.textContent = lat + 'ms';
        if (statusCell) statusCell.innerHTML = data.ok
          ? `<span class="cfg-status-badge cfg-status-healthy">● HEALTHY</span>`
          : `<span class="cfg-status-badge cfg-status-degraded">● DEAD</span>`;
        if (data.ok) ok++; else fail++;
      } catch {
        if (latEl) latEl.textContent = '-';
        if (statusCell) statusCell.innerHTML = `<span class="cfg-status-badge cfg-status-degraded">● DEAD</span>`;
        fail++;
      }
    }
    btn.textContent = 'Test All';
    btn.disabled = false;
    showToast(`Proxy check done: ${ok} OK, ${fail} dead (of ${toTest.length} tested)`, ok > 0 ? 'success' : 'error');
  });

  // -- Proxy file input handler (.txt) --
  document.getElementById('proxy-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result || '';
      const ta = document.getElementById('set-proxy-list');
      if (ta) ta.value = text.trim();
      updateProxyCount();
      showToast(`📂 Loaded ${text.split('\n').filter(l=>l.trim()).length} proxies from ${file.name}`, 'success');
    };
    reader.readAsText(file);
  });

  // -- Update proxy count --
  window.updateProxyCount = () => {
    const ta = document.getElementById('set-proxy-list');
    const el = document.getElementById('proxy-count-num');
    if (ta && el) el.textContent = ta.value.split('\n').filter(l => l.trim()).length;
  };
  document.getElementById('set-proxy-list')?.addEventListener('input', updateProxyCount);

  // -- AI: Custom model toggle --
  document.getElementById('set-ai-model')?.addEventListener('change', (e) => {
    const wrap = document.getElementById('custom-model-wrap');
    if (wrap) wrap.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  // -- Custom App ID toggle --
  document.getElementById('set-login-appid')?.addEventListener('change', (e) => {
    const wrap = document.getElementById('custom-appid-wrap');
    if (wrap) wrap.style.display = e.target.value === 'custom_appid' ? 'block' : 'none';
  });

  // -- AI: Test Connection --
  document.getElementById('btn-test-ai')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-ai');
    const resultEl = document.getElementById('ai-test-result');
    btn.textContent = 'Testing…';
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<span style="color:var(--text-3)">Sending test prompt…</span>';
    try {
      const res = await api('/ai/test', { method: 'POST' });
      if (res.success) {
        resultEl.innerHTML = `<span style="color:var(--green)">✓ Connected - model responded in ${res.ms}ms</span>`;
        showToast('AI connection OK', 'success');
      } else {
        resultEl.innerHTML = `<span style="color:var(--red)">✗ ${res.error}</span>`;
        showToast('AI test failed', 'error');
      }
    } catch (e) {
      resultEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`;
    }
    btn.textContent = 'Test';
  });

  // Auto-check 2Captcha balance on settings render
  setTimeout(() => {
    document.getElementById('btn-check-captcha')?.click();
  }, 100);
}

// -- AI Provider card selection --
window.selectAiProvider = (id) => {
  document.querySelectorAll('.ai-provider-card').forEach(el => {
    el.classList.toggle('active', el.dataset.provider === id);
  });
  // Persist selection in hidden field (saved with rest of settings)
  const existing = document.getElementById('set-ai-provider-hidden');
  if (existing) existing.value = id;
  else {
    const inp = document.createElement('input');
    inp.type = 'hidden'; inp.id = 'set-ai-provider-hidden'; inp.name = 'ai_provider'; inp.value = id;
    document.body.appendChild(inp);
  }
};

// Active Browsers List (Dashboard)
window.refreshBrowsersList = async () => {
  const container = document.getElementById('db-browsers-list');
  if (!container) return;
  try {
    const browsers = await api('/browsers');
    if (!Array.isArray(browsers) || !browsers.length) {
      container.innerHTML = `<div style="font-size:11px;color:var(--text-3);text-align:center;padding:8px;font-style:italic">No active browsers</div>`;
      return;
    }
    container.innerHTML = browsers.map(b => `
      <div class="db-browser-item">
        <div class="db-browser-dot" style="background:${b.platform === 'psn' ? 'var(--psn)' : 'var(--xbox)'}"></div>
        <div class="db-browser-info">
          <span class="db-browser-name">${b.username || 'Unknown'}</span>
          <span class="db-browser-plat">${b.platform?.toUpperCase() || '-'}</span>
        </div>
        <div class="db-browser-pid" style="font-size:10px;color:var(--text-3);font-family:var(--font-data)">PID ${b.pid || '-'}</div>
      </div>`).join('');
  } catch {
    container.innerHTML = `<div style="font-size:11px;color:var(--text-3);text-align:center;padding:8px">-</div>`;
  }
};

// Global Functions (called from onclick)

window.deleteTicketById = async (id) => {
  if (!confirm('Delete this ticket?')) return;
  await api(`/tickets/${id}`, { method: 'DELETE' });
  showToast('Ticket deleted', 'success');
  loadTickets();
};

window.deleteAccountById = async (id) => {
  if (!confirm('Delete this account and all its tickets?')) return;
  await api(`/accounts/${id}`, { method: 'DELETE' });
  showToast('Account deleted', 'success');
  renderAccounts();
};

window.deleteFailedById = async (id) => {
  await api(`/failed-accounts/${id}`, { method: 'DELETE' });
  showToast('Removed', 'success');
  renderFailed();
};

window.createTicketAction = async (accountId) => {
  // Fetch account info for preview
  let account = {};
  try { account = await api(`/accounts/${accountId}`); } catch {}

  // Show reason selector modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'create-ticket-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 480px;">
      <div class="modal-header">
        <h3>🎫 Create Ticket - Account Recovery</h3>
        <button class="btn-icon" onclick="document.getElementById('create-ticket-modal').remove()">✕</button>
      </div>
      <div class="modal-body" style="padding: 1.2rem;">
        <div style="background: var(--bg-secondary); border-radius: 10px; padding: 1rem; margin-bottom: 1rem;">
          <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem;">
            <span style="font-weight: 600; font-size: 1rem;">${account.username || 'Unknown'}</span>
            <span class="platform-badge ${(account.platform || '').toLowerCase()}" style="font-size: 0.75rem;">${account.platform || '?'}</span>
          </div>
          <div style="font-size: 0.82rem; color: var(--text-secondary); line-height: 1.6;">
            <div><strong>Lost Email:</strong> ${account.login_email || '-'}</div>
            <div><strong>Contact Email:</strong> ${account.platform_login_email || account.backup_email || account.login_email || '-'}</div>
          </div>
        </div>
        <label style="font-weight: 600; margin-bottom: 0.4rem; display: block;">Recovery Reason</label>
        <select id="ticket-reason-select" class="form-input" style="width: 100%; padding: 0.7rem; font-size: 0.95rem;">
          <option value="accountHackedOrTakenOver" selected>🔓 Account hacked or taken over</option>
          <option value="lostAccessToEmail">📧 Lost access to email</option>
          <option value="forgotCredentials">🔑 Forgot credentials</option>
          <option value="other">❓ Other</option>
        </select>
        <div style="margin-top: 1rem; display: flex; gap: 0.6rem; justify-content: flex-end;">
          <button class="btn btn-secondary" onclick="document.getElementById('create-ticket-modal').remove()">Cancel</button>
          <button class="btn btn-primary" id="confirm-create-ticket-btn" onclick="window._confirmCreateTicket(${accountId})">🎫 Submit Ticket</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
};

window._confirmCreateTicket = async (accountId) => {
  const reason = document.getElementById('ticket-reason-select')?.value || 'accountHackedOrTakenOver';
  const btn = document.getElementById('confirm-create-ticket-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating...'; }

  // Close modal
  const modal = document.getElementById('create-ticket-modal');

  showToast('🎫 Creating ticket...', 'info');
  try {
    const result = await api(`/tickets/create/${accountId}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    if (modal) modal.remove();
    if (result.success) {
      showToast(`✅ Ticket #${result.caseNumber} created!`, 'success');
      if (typeof openAccountDrawer === 'function') openAccountDrawer(accountId);
      if (typeof renderAccounts === 'function') renderAccounts();
    } else {
      showToast(`❌ Error: ${result.error}`, 'error');
    }
  } catch (e) {
    if (modal) modal.remove();
    showToast(`❌ Request failed: ${e.message}`, 'error');
  }
};

window.closeTicketAction = async (ticketId) => {
  if (!confirm('Close this ticket without creating a new one?')) return;
  const result = await api(`/tickets/${ticketId}/close`, { method: 'POST' });
  if (result.success) showToast('Ticket closed', 'success');
  else showToast(`Error: ${result.error}`, 'error');
};

window.regenerateTicketAction = async (ticketId) => {
  if (!confirm('Close this ticket AND create a new one?')) return;
  showToast('Regenerating ticket...', 'info');
  const result = await api(`/tickets/${ticketId}/regenerate`, { method: 'POST' });
  if (result.success) showToast(`New ticket #${result.newCaseNumber} created!`, 'success');
  else showToast(`Error: ${result.error}`, 'error');
};

window.openTicketChat = async (ticketId) => {
  currentChatTicketId = ticketId; // Track which chat is open for auto-refresh
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="content-body"><div class="loading-overlay"><div class="spinner"></div></div></div>`;

  const [ticket, messages] = await Promise.all([
    api(`/tickets/${ticketId}`),
    api(`/tickets/${ticketId}/messages`),
  ]);
  const account = await api(`/accounts/${ticket.account_id}`);

  main.innerHTML = `
    <div class="content-header">
      <div>
        <div class="content-title">💬 ${account.username} <span class="badge badge-${ticket.platform === 'XBL' ? 'xbox' : 'psn'}">${ticket.platform === 'XBL' ? 'Xbox' : 'PSN'}</span> <span class="badge badge-${statusClass(ticket.status)}">${ticket.status}</span></div>
        <div class="content-subtitle">Case #${ticket.case_number || '-'} · ${account.login_email}</div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-secondary" onclick="renderTickets()">← Back</button>
        <button class="btn btn-secondary" onclick="pollTicketAction(${ticketId})">↻ Refresh</button>
        <button class="btn btn-danger" onclick="closeTicketAction(${ticketId})">🔴 Close</button>
        <button class="btn btn-primary" onclick="regenerateTicketAction(${ticketId})">🔄 Regenerate</button>
      </div>
    </div>
    <div class="chat-container">
      <div class="chat-main">
        <div class="chat-messages" id="chat-messages">
          ${messages.length ? messages.map(m => chatBubble(m)).join('') : '<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-title">No messages yet</div><div class="empty-state-text">Waiting for agent response.</div></div>'}
        </div>
        <div class="ai-suggestion-bar" id="ai-suggestion-bar" style="display:none;padding:10px 14px;background:var(--bg-3);border-top:1px solid var(--border)">
          <div style="font-size:11px;color:var(--accent);margin-bottom:4px;font-weight:600">🤖 AI Suggestion</div>
          <div id="ai-suggestion-text" style="font-size:13px;color:var(--text-0);margin-bottom:8px;white-space:pre-wrap;line-height:1.5"></div>
          <div class="flex gap-2">
            <button class="btn btn-sm btn-primary" onclick="acceptAiSuggestion(${ticketId})">✓ Accept & Send</button>
            <button class="btn btn-sm btn-secondary" onclick="editAiSuggestion()">✏️ Edit</button>
            <button class="btn btn-sm btn-secondary" onclick="requestAiSuggestion(${ticketId})">🔄 New</button>
            <button class="btn btn-sm btn-danger" onclick="document.getElementById('ai-suggestion-bar').style.display='none'">✕</button>
          </div>
        </div>
        <div class="chat-input-bar">
          <textarea class="form-input" id="chat-reply-input" placeholder="Type your reply... (Enter to send, Shift+Enter for new line)" rows="2"></textarea>
          <div class="flex gap-2" style="align-self:flex-end">
            <button class="btn btn-secondary btn-lg" onclick="requestAiSuggestion(${ticketId})" title="Get AI suggestion">🤖 AI Suggest</button>
            <button class="btn btn-primary btn-lg" onclick="replyToTicketAction(${ticketId})">📤 Send</button>
          </div>
        </div>
      </div>
      <div class="chat-sidebar">
        <div class="card mb-4"><div class="card-header"><div class="card-title">👤 Account Info</div></div><div class="card-body" style="padding:10px">
          <div class="chat-sidebar-field"><span class="text-muted">Username</span><strong>${account.username}</strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Level</span><strong>Lv.${account.account_level}</strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Platform</span><strong><span class="badge badge-${account.platform === 'XBL' ? 'xbox' : 'psn'}">${account.platform === 'XBL' ? 'Xbox' : 'PSN'}</span></strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Login</span><strong style="font-size:11px;word-break:break-all">${account.login_email}</strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Linked</span><strong>${account.date_linked || '-'}</strong></div>
        </div></div>
        <div class="card mb-4"><div class="card-header"><div class="card-title">🎫 Ticket Details</div></div><div class="card-body" style="padding:10px">
          <div class="chat-sidebar-field"><span class="text-muted">Case #</span><strong>${ticket.case_number || '-'}</strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Status</span><strong><span class="badge badge-${statusClass(ticket.status)}">${ticket.status}</span></strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Contact</span><strong style="font-size:11px;word-break:break-all">${ticket.contact_email || '-'}</strong></div>
          <div class="chat-sidebar-field"><span class="text-muted">Platform Email</span><strong style="font-size:11px;word-break:break-all">${account.platform_login_email || '-'}</strong></div>
        </div></div>
        <div class="card mb-4"><div class="card-header"><div class="card-title">📝 Notes</div></div><div class="card-body" style="padding:10px">
          <textarea class="form-textarea" id="ticket-notes" rows="4" style="font-size:12px" placeholder="Add notes...">${ticket.notes || ''}</textarea>
          <button class="btn btn-sm btn-secondary" onclick="saveTicketNotes(${ticketId})" style="width:100%;margin-top:8px">💾 Save Notes</button>
        </div></div>
        <div class="card mb-4"><div class="card-header"><div class="card-title">⚡ Quick Actions</div></div><div class="card-body" style="padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:8px;background:var(--bg-3);border-radius:8px">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--text-0)">🤖 AI Auto-Reply</div>
              <div style="font-size:10px;color:var(--text-3)">AI responds automatically</div>
            </div>
            <label class="cfg-toggle">
              <input type="checkbox" id="ai-auto-toggle" ${ticket.ai_auto_reply ? 'checked' : ''} onchange="toggleAiAuto(${ticketId}, this.checked)" />
              <span class="cfg-toggle-track"></span>
            </label>
          </div>
          ${ticket.platform === 'PSN' ? `<button class="btn btn-sm btn-secondary" onclick="launchBrowserAction(${ticket.account_id},'psn')" style="width:100%;margin-bottom:6px">🌐 Open PSN Browser</button>` : ''}
          ${ticket.platform === 'XBL' ? `<button class="btn btn-sm btn-secondary" onclick="launchBrowserAction(${ticket.account_id},'xbox')" style="width:100%;margin-bottom:6px">🌐 Open Xbox Browser</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="closeTicketAction(${ticketId})" style="width:100%;margin-bottom:6px">🔴 Close Ticket</button>
          <button class="btn btn-sm btn-primary" onclick="regenerateTicketAction(${ticketId})" style="width:100%">🔄 Regenerate Ticket</button>
        </div></div>
      </div>
    </div>`;

  // Auto-scroll chat to bottom
  const chatEl = document.getElementById('chat-messages');
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

  // Enter to send
  document.getElementById('chat-reply-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replyToTicketAction(ticketId); }
  });

  // Make renderTickets accessible as back button
  window.renderTickets = renderTickets;
};

window.replyToTicketAction = async (ticketId) => {
  const input = document.getElementById('chat-reply-input');
  const body = input?.value?.trim();
  if (!body) { showToast('Type a message first', 'warning'); return; }
  input.value = '';
  showToast('Sending reply...', 'info');
  const result = await api(`/tickets/${ticketId}/reply`, { method: 'POST', body: JSON.stringify({ body }) });
  if (result.success) { showToast('Reply sent', 'success'); openTicketChat(ticketId); }
  else showToast(`Error: ${result.error}`, 'error');
};

window.pollTicketAction = async (ticketId) => {
  showToast('Refreshing ticket...', 'info');
  await api(`/tickets/${ticketId}/poll`, { method: 'POST' });
  openTicketChat(ticketId);
};

window.saveTicketNotes = async (ticketId) => {
  const notes = document.getElementById('ticket-notes')?.value || '';
  await api(`/tickets/${ticketId}/notes`, { method: 'PUT', body: JSON.stringify({ notes }) });
  showToast('Notes saved', 'success');
};

window.showManualAuthModal = (accountId) => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Manual Authentication</div><button class="toast-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text-2);margin-bottom:12px">Paste the login JSON dictionary below:</p>
        <textarea class="form-textarea" id="manual-auth-json" rows="8" placeholder='{"ticket": "...", "profileId": "...", ...}'></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="submitManualAuth(${accountId})">Submit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

window.submitManualAuth = async (accountId) => {
  const json = document.getElementById('manual-auth-json')?.value;
  if (!json?.trim()) { showToast('Paste auth JSON', 'warning'); return; }
  const result = await api(`/accounts/${accountId}/manual-auth`, { method: 'POST', body: JSON.stringify({ authJson: json }) });
  if (result.success) { showToast('Account authenticated!', 'success'); document.querySelector('.modal-overlay')?.remove(); renderAccounts(); }
  else showToast(`Error: ${result.error}`, 'error');
};

// AI Suggestion Functions
window.requestAiSuggestion = async (ticketId) => {
  showToast('Generating AI reply...', 'info');
  const bar = document.getElementById('ai-suggestion-bar');
  const textEl = document.getElementById('ai-suggestion-text');
  if (bar) bar.style.display = 'block';
  if (textEl) textEl.textContent = 'Generating...';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const result = await api(`/tickets/${ticketId}/suggest`, { method: 'POST', signal: controller.signal });
    clearTimeout(timeoutId);
    if (result.success) {
      if (textEl) textEl.textContent = result.suggestion;
    } else {
      if (textEl) textEl.textContent = `Error: ${result.error}`;
      showToast(`AI error: ${result.error}`, 'error');
    }
  } catch (e) {
    if (textEl) textEl.textContent = 'Timeout - AI did not respond in 30s';
    showToast('AI request timed out', 'error');
  }
};

window.acceptAiSuggestion = async (ticketId) => {
  const text = document.getElementById('ai-suggestion-text')?.textContent;
  if (!text || text.startsWith('Error:') || text === 'Generating...') { showToast('No valid suggestion', 'warning'); return; }
  document.getElementById('ai-suggestion-bar').style.display = 'none';
  showToast('Sending AI suggestion...', 'info');
  const result = await api(`/tickets/${ticketId}/reply`, { method: 'POST', body: JSON.stringify({ body: text }) });
  if (result.success) { showToast('Reply sent', 'success'); openTicketChat(ticketId); }
  else showToast(`Error: ${result.error}`, 'error');
};

window.editAiSuggestion = () => {
  const text = document.getElementById('ai-suggestion-text')?.textContent;
  const input = document.getElementById('chat-reply-input');
  if (input && text) input.value = text;
  document.getElementById('ai-suggestion-bar').style.display = 'none';
};

// Open Ubisoft Profile (eye icon) - launches CamoFox browser to Ubisoft tickets
window.openUbisoftProfile = async (accountId) => {
  showToast('Launching browser...', 'info');
  const result = await api(`/accounts/${accountId}/open-profile`, { method: 'POST' });
  if (result.success) {
    showToast(result.message || 'Browser opened', 'success');
  } else {
    showToast(`Error: ${result.error || 'Could not open browser'}`, 'error');
  }
  showAccountDetail(accountId);
};

// CamoFox Browser Launch
window.launchBrowserAction = async (accountId, platform) => {
  showToast(`Launching ${platform.toUpperCase()} browser...`, 'info');
  const result = await api(`/accounts/${accountId}/browser/${platform}`, { method: 'POST' });
  if (result.success) showToast(result.message, 'success');
  else showToast(`Error: ${result.error}`, 'error');
};

window.toggleAiAuto = async (ticketId, enabled) => {
  const result = await api(`/tickets/${ticketId}/ai-toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  if (result.success !== false) {
    showToast(enabled ? '🤖 AI Auto-Reply enabled' : '🤖 AI Auto-Reply disabled', 'success');
  } else {
    showToast(`Error: ${result.error}`, 'error');
  }
};

// Retry Login
window.retryLoginAction = async (accountId) => {
  showToast('Attempting auto-login...', 'info');
  const result = await api(`/accounts/${accountId}/retry-login`, { method: 'POST' });
  if (result.status === 'authenticated') { showToast('Login successful! ✅', 'success'); renderAccounts(); }
  else showToast(`Login failed: ${result.reason || result.status}`, 'error');
};

// Account Detail Drawer
window.showAccountDetail = async (accountId) => {
  // Remove existing drawer
  document.querySelector('.acc-drawer-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'acc-drawer-overlay';
  overlay.innerHTML = `<div class="acc-drawer"><div class="acc-drawer-inner"><div class="loading-overlay"><div class="spinner"></div><span>Loading...</span></div></div></div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.querySelector('.acc-drawer').classList.add('open'));

  const [account, ticketsAll] = await Promise.all([
    api(`/accounts/${accountId}`),
    api('/tickets?'),
  ]);
  const tickets = ticketsAll.filter ? ticketsAll.filter(t => t.account_id === accountId) : [];

  const platformColor = account.platform === 'XBL' ? 'var(--xbox)' : 'var(--psn)';
  const platformBg = account.platform === 'XBL' ? 'var(--xbox-10)' : 'var(--psn-10)';
  const initials = (account.username || '?').substring(0,2).toUpperCase();

  overlay.querySelector('.acc-drawer-inner').innerHTML = `
    <div class="acc-drawer-header">
      <div class="acc-drawer-avatar" style="background:${platformBg};color:${platformColor}">${initials}</div>
      <div class="acc-drawer-headinfo">
        <div class="acc-drawer-name">${account.username}</div>
        <div class="acc-drawer-email">${account.login_email || ''}</div>
      </div>
      <button class="acc-drawer-close" onclick="this.closest('.acc-drawer-overlay').remove()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="acc-drawer-body">
      <div class="acc-drawer-section">
        <div class="acc-drawer-section-title">Account Info</div>
        <div class="acc-drawer-field"><span>Status</span><span class="acc-status-badge acc-status-${account.login_status}">${formatLoginStatus(account.login_status)}</span></div>
        <div class="acc-drawer-field"><span>Platform</span><span style="color:${platformColor};font-weight:600">${account.platform === 'XBL' ? 'Xbox' : 'PlayStation'}</span></div>
        <div class="acc-drawer-field"><span>Level</span><span>Lv.${account.account_level || 0}</span></div>
        <div class="acc-drawer-field"><span>Platform Email</span><span class="acc-drawer-mono">${account.platform_login_email || '-'}</span></div>
        <div class="acc-drawer-field"><span>Backup Email</span><span class="acc-drawer-mono">${account.backup_email || '-'}</span></div>
        <div class="acc-drawer-field"><span>Date Linked</span><span>${account.date_linked || '-'}</span></div>
        <div class="acc-drawer-field"><span>Profile ID</span><span class="acc-drawer-mono" style="font-size:10px">${account.profile_id || '-'}</span></div>
      </div>

      <div class="acc-drawer-section">
        <div class="acc-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>Tickets (${tickets.length})</span>
          ${account.login_status === 'authenticated' ? `<button class="btn btn-sm btn-primary" onclick="createTicketAction(${accountId})">+ Create</button>` : `<button class="btn btn-sm btn-primary" style="background:var(--orange);border-color:var(--orange)" onclick="retryLoginAction(${accountId})">↺ Auto Login</button>`}
        </div>
        ${tickets.length ? tickets.slice(0,5).map(t => `
          <div class="acc-drawer-ticket" onclick="openTicketChat(${t.id})">
            <div>
              <div style="font-weight:600;font-size:12px;color:var(--text-0)">#${t.case_number || 'No case #'}</div>
              <div style="font-size:11px;color:var(--text-3)">${formatDate(t.opened_at)}</div>
            </div>
            <span class="acc-status-badge acc-status-${t.status.toLowerCase().replace(/\s+/g,'-')}">${t.status}</span>
          </div>`).join('') : `<div style="text-align:center;padding:20px;color:var(--text-3);font-size:12px">No tickets yet</div>`}
      </div>

      <div class="acc-drawer-section">
        <div class="acc-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
          Notes
          <button class="btn btn-sm btn-primary" id="btn-save-acc-notes" style="padding:4px 10px;font-size:11px">Save</button>
        </div>
        <textarea class="form-textarea" id="acc-notes-area" rows="3"
          style="font-size:12px;margin-top:6px;resize:vertical"
          placeholder="Add notes about this account...">${account.notes || ''}</textarea>
      </div>

      <div class="acc-drawer-actions">
        ${account.login_status === 'authenticated'
          ? `<button class="btn btn-primary w-full" onclick="createTicketAction(${accountId})">🎫 Create Ticket</button>`
          : `<button class="btn btn-primary w-full" style="background:var(--orange);border-color:var(--orange)" onclick="retryLoginAction(${accountId})">↺ Auto Login</button>`}
        <button class="btn btn-secondary w-full" style="border-color:var(--red);color:var(--red)" onclick="if(confirm('Delete account?')){deleteAccountById(${accountId});this.closest('.acc-drawer-overlay').remove()}">🗑 Delete Account</button>
      </div>
    </div>`;

  // Wire up Save Notes button after DOM is rendered
  setTimeout(() => {
    document.getElementById('btn-save-acc-notes')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-save-acc-notes');
      const notes = document.getElementById('acc-notes-area')?.value || '';
      if (btn) { btn.disabled = true; btn.textContent = '...'; }
      const result = await api(`/accounts/${accountId}/notes`, {
        method: 'PUT',
        body: JSON.stringify({ notes }),
      });
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      if (result.success !== false) showToast('Notes saved', 'success');
      else showToast('Failed to save notes', 'error');
    });
  }, 50);
};

// Bulk Delete
// Multi-select helpers
window.toggleSelectAll = (master) => {
  document.querySelectorAll('.acc-select-cb').forEach(cb => { cb.checked = master.checked; });
  updateBulkSelection();
};

window.updateBulkSelection = () => {
  const checked = document.querySelectorAll('.acc-select-cb:checked');
  const wrap = document.getElementById('bulk-actions-wrap');
  const count = document.getElementById('bulk-sel-count');
  if (wrap) wrap.style.display = checked.length > 0 ? 'flex' : 'none';
  if (count) count.textContent = checked.length;
};

window.bulkCreateTicketsForSelected = () => {
  const checked = [...document.querySelectorAll('.acc-select-cb:checked')];
  const authIds = checked.filter(cb => cb.dataset.status === 'authenticated').map(cb => Number(cb.dataset.id));
  const skipped = checked.length - authIds.length;

  if (!authIds.length) {
    showToast('❌ No authenticated accounts selected', 'error');
    return;
  }

  // Show reason selector modal for bulk
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'bulk-create-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 480px;">
      <div class="modal-header">
        <h3>🎫 Bulk Create Tickets</h3>
        <button class="btn-icon" onclick="document.getElementById('bulk-create-modal').remove()">✕</button>
      </div>
      <div class="modal-body" style="padding: 1.2rem;">
        <div style="background: var(--bg-secondary); border-radius: 10px; padding: 1rem; margin-bottom: 1rem;">
          <div style="font-size: 1rem; font-weight: 600; color: var(--text-0);">
            ${authIds.length} account${authIds.length > 1 ? 's' : ''} selected
          </div>
          <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 4px;">
            ${skipped > 0 ? `⚠️ ${skipped} non-authenticated account(s) will be skipped` : 'All selected accounts are authenticated ✅'}
          </div>
        </div>
        <label style="font-weight: 600; margin-bottom: 0.4rem; display: block;">Recovery Reason</label>
        <select id="bulk-reason-select" class="form-input" style="width: 100%; padding: 0.7rem; font-size: 0.95rem;">
          <option value="accountHackedOrTakenOver" selected>🔓 Account hacked or taken over</option>
          <option value="lostAccessToEmail">📧 Lost access to email</option>
          <option value="forgotCredentials">🔑 Forgot credentials</option>
          <option value="other">❓ Other</option>
        </select>
        <div style="margin-top: 1rem; display: flex; gap: 0.6rem; justify-content: flex-end;">
          <button class="btn btn-secondary" onclick="document.getElementById('bulk-create-modal').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-bulk-confirm" style="background:var(--purple)">🎫 Create ${authIds.length} Ticket${authIds.length > 1 ? 's' : ''}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('btn-bulk-confirm').addEventListener('click', async () => {
    const reason = document.getElementById('bulk-reason-select')?.value || 'accountHackedOrTakenOver';
    const confirmBtn = document.getElementById('btn-bulk-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ Processing...';

    document.getElementById('bulk-create-modal')?.remove();
    showToast(`🎫 Creating ${authIds.length} tickets sequentially...`, 'info');

    let ok = 0, fail = 0;
    for (const accId of authIds) {
      try {
        const result = await api(`/tickets/create/${accId}`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        if (result.success) {
          ok++;
          showToast(`✅ #${result.caseNumber} created (${ok}/${authIds.length})`, 'success');
        } else {
          fail++;
          showToast(`❌ Account #${accId}: ${result.error}`, 'error');
        }
      } catch (e) {
        fail++;
        showToast(`❌ Account #${accId}: ${e.message}`, 'error');
      }
    }
    showToast(`📊 Bulk create done: ${ok} success, ${fail} failed`, ok > 0 ? 'success' : 'error');
    if (typeof renderAccounts === 'function') renderAccounts();
  });
};

window.bulkDeleteTickets = async () => {
  const platform = document.getElementById('filter-platform')?.value || '';
  const status = document.getElementById('filter-status')?.value || '';
  if (!platform && !status) { if (!confirm('Delete ALL tickets? This cannot be undone.')) return; }
  else { if (!confirm(`Delete all ${platform || 'any platform'} tickets with status "${status || 'any'}"?`)) return; }
  const result = await api('/tickets/bulk-delete', { method: 'POST', body: JSON.stringify({ platform: platform || undefined, status: status || undefined }) });
  if (result.success) { showToast(`Deleted ${result.deleted} tickets`, 'success'); loadTickets(); }
  else showToast(`Error: ${result.error}`, 'error');
};

// Bulk Delete selected accounts
window.bulkDeleteSelected = async () => {
  const checked = [...document.querySelectorAll('.acc-select-cb:checked')];
  if (!checked.length) { showToast('No accounts selected', 'warning'); return; }
  if (!confirm(`Delete ${checked.length} account(s) and all their tickets? This cannot be undone.`)) return;
  let ok = 0;
  for (const cb of checked) {
    try {
      await api(`/accounts/${cb.dataset.id}`, { method: 'DELETE' });
      ok++;
    } catch {}
  }
  showToast(`🗑 Deleted ${ok} account(s)`, 'success');
  renderAccounts();
};

// Bulk View - navigates to tickets page filtered by selected accounts' tickets
window.bulkViewSelected = async () => {
  const checked = [...document.querySelectorAll('.acc-select-cb:checked')];
  if (!checked.length) { showToast('No accounts selected', 'warning'); return; }
  const ids = checked.map(cb => Number(cb.dataset.id));
  // Fetch all tickets and filter
  const allTickets = await api('/tickets?');
  const matching = Array.isArray(allTickets) ? allTickets.filter(t => ids.includes(t.account_id)) : [];
  if (!matching.length) { showToast('No tickets found for selected accounts', 'info'); return; }
  // Navigate to tickets page and show matching
  currentPage = 'tickets';
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelector('.nav-item[data-page="tickets"]')?.classList.add('active');
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="content-header">
      <div><div class="content-title">🎫 Tickets for Selected Accounts</div>
      <div class="content-subtitle">${matching.length} ticket(s) for ${ids.length} account(s)</div></div>
      <button class="btn btn-secondary" onclick="renderTickets()">← All Tickets</button>
    </div>
    <div class="content-body">
      <div class="card">
        <table class="data-table">
          <thead><tr>
            <th>Account</th><th>Platform</th><th>Status</th><th>Opened</th><th style="text-align:right">Actions</th>
          </tr></thead>
          <tbody>
            ${matching.map(t => `
              <tr onclick="openTicketChat(${t.id})" style="cursor:pointer">
                <td><div class="account-username">${t.username || 'Unknown'}</div><div class="text-sm text-muted">#${t.case_number || '-'}</div></td>
                <td><span class="badge badge-${t.platform === 'XBL' ? 'xbox' : 'psn'}">${t.platform === 'XBL' ? 'Xbox' : 'PSN'}</span></td>
                <td><span class="badge badge-${statusClass(t.status)}">${t.status}</span></td>
                <td class="text-sm text-muted">${formatDate(t.opened_at)}</td>
                <td class="text-right">
                  <div class="btn-group" style="justify-content:flex-end">
                    <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();closeTicketAction(${t.id})">🔴 Close</button>
                    <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteTicketById(${t.id})">✕</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
};

// Bulk Auto-Auth All Accounts
window.bulkAuthAllAccounts = async () => {
  const btn = document.getElementById('btn-auth-all');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Logging in...'; }
  showToast('🔐 Starting bulk authentication for all accounts...', 'info');
  const result = await api('/accounts/bulk-login', { method: 'POST' });
  if (result.success) {
    showToast('✅ Bulk login running in background. Table will refresh automatically.', 'success');
  } else {
    showToast(`Error: ${result.error}`, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Auth All'; }
  }
};

// Helpers
function statusClass(status) {
  const map = { 'Open': 'open', 'Awaiting Reply': 'awaiting-reply', 'Awaiting Response': 'awaiting-response', 'Completed': 'completed' };
  return map[status] || 'pending';
}

function loginStatusClass(status) {
  const map = { 'authenticated': 'authenticated', 'manual_login_required': 'manual', 'pending': 'pending', 'failed': 'failed' };
  return map[status] || 'pending';
}

function formatLoginStatus(status) {
  const map = { 'authenticated': 'Authenticated', 'manual_login_required': 'Manual Login', 'pending': 'Pending', 'failed': 'Failed' };
  return map[status] || status;
}

function formatDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) { el.textContent = count; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span style="flex:1;font-size:13px">${message}</span><button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// Chat Bubble Helper
function chatBubble(msg) {
  // Detect if message is from Ubisoft agent (not from the account owner)
  const createdBy = msg.created_by || msg.createdBy || '';
  const senderType = msg.sender_type || msg.senderType || '';
  // Agent if explicitly flagged, or if senderType contains 'agent'/'support', or created_by has 'Ubisoft'
  const isAgent = senderType.toLowerCase().includes('agent')
    || senderType.toLowerCase().includes('support')
    || createdBy.toLowerCase().includes('ubisoft')
    || createdBy.toLowerCase().includes('agent')
    || createdBy.toLowerCase().includes('alex')  // common Ubisoft agent name
    || msg.is_agent === true;

  const cls = isAgent ? 'agent' : 'user';
  const agentName = isAgent ? (createdBy || 'Ubisoft Support') : 'You';
  const initial = agentName.charAt(0).toUpperCase();
  const avatarColor = isAgent ? '#4f8ef7' : '#22d472';

  const rawTime = msg.created_at_remote || msg.createdAt || msg.created_at || '';
  const time = rawTime ? new Date(rawTime).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : '';

  const body = escapeHtml(msg.body || msg.content || msg.message || '')
    .replace(/\n/g, '<br>');

  return `<div class="chat-bubble ${cls}">
    <div class="chat-bubble-avatar" style="background:${avatarColor}">${initial}</div>
    <div class="chat-bubble-inner">
      <div class="chat-bubble-header">
        <span class="chat-bubble-name">${agentName}</span>
        <span class="chat-bubble-time">${time}</span>
      </div>
      <div class="chat-bubble-body">${body}</div>
    </div>
  </div>`;
}


function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Browser Notifications
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendBrowserNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '🎫' });
  }
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.value = 0.1;
    osc.start(); osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => { const o2 = ctx.createOscillator(); o2.connect(gain); o2.frequency.value = 1100; o2.type = 'sine'; o2.start(); o2.stop(ctx.currentTime + 0.15); }, 200);
  } catch {}
}

// Init
setupNavigation();
connectWebSocket();
renderDashboard();
requestNotificationPermission();
