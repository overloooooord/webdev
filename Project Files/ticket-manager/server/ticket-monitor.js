// Ticket Monitor — Polls Ubisoft API for ticket status changes and new messages
import {
  getAllTickets, getTicketById, updateTicketStatus, getAccountById,
  insertMessage, getLatestMessage, getSetting,
} from './database.js';
import { getTicketStatus, getTicketInteractions } from './ubisoft-api.js';

let monitorInterval = null;
let isMonitoring = false;

/**
 * Start the ticket monitoring loop
 */
export function startTicketMonitor(broadcastFn) {
  const intervalSec = parseInt(getSetting('poll_interval_seconds')) || 45;
  console.log(`[MONITOR] Starting ticket monitor (every ${intervalSec}s)`);

  // First poll after 15 seconds
  setTimeout(() => pollAllTickets(broadcastFn), 15000);

  monitorInterval = setInterval(() => pollAllTickets(broadcastFn), intervalSec * 1000);
}

/**
 * Stop the monitoring loop
 */
export function stopTicketMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[MONITOR] Ticket monitor stopped');
  }
}

/**
 * Poll all active tickets for status changes and new messages
 */
async function pollAllTickets(broadcastFn) {
  if (isMonitoring) return;
  isMonitoring = true;

  try {
    // Only check active tickets (not Completed) with valid Ubisoft case numbers
    // Skip dummy/test case numbers (e.g. "CS-78234512" prefix) — real ones are pure numeric like "26358701"
    const activeTickets = getAllTickets()
      .filter(t => t.status !== 'Completed' && t.case_number && /^\d+$/.test(t.case_number));

    if (!activeTickets.length) {
      return;
    }

    const proxy = getSetting('proxy_us');

    for (const ticket of activeTickets) {
      try {
        await pollSingleTicket(ticket, proxy, broadcastFn);
        // Stagger polls to avoid rate limiting
        await sleep(2000);
      } catch (err) {
        console.error(`[MONITOR] Error polling ticket #${ticket.case_number}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[MONITOR] Critical poll cycle error (recovered):', err.message);
  } finally {
    isMonitoring = false;
  }
}

/**
 * Poll a single ticket for status + new messages
 */
async function pollSingleTicket(ticket, proxy, broadcastFn) {
  const account = getAccountById(ticket.account_id);
  if (!account || !account.ubisoft_token) return;

  const authOpts = {
    token: account.ubisoft_token,
    sessionId: account.session_id,
    proxy,
  };

  // 1) Check ticket status
  const statusResult = await getTicketStatus(ticket.case_number, authOpts);

  // Handle auth errors — token may have expired for this account's token
  if (!statusResult.success && (statusResult.status === 401 || statusResult.status === 400)) {
    console.log(`[MONITOR] Ticket #${ticket.case_number}: API returned ${statusResult.status} (skipping this cycle)`);
    return;
  }
  if (statusResult.success && statusResult.data?.status?.name) {
    const ubiStatus = statusResult.data.status.name;
    const lower = (ubiStatus || '').toLowerCase();

    // ── IMPORTANT: If Ubisoft closes the ticket on their end, do NOT mark it
    // as Completed in our system. Agents sometimes prematurely close tickets.
    // The user can still reply — sending a comment auto-reopens it on Ubisoft's side.
    // Only a manual "Close Ticket" button press marks it Completed here.
    if (lower === 'closed') {
      console.log(`[MONITOR] Ticket #${ticket.case_number} was closed by Ubisoft agent (keeping open on our side)`);
      // Keep our status as-is but set to Awaiting Reply so user knows to respond
      if (ticket.status !== 'Awaiting Reply') {
        updateTicketStatus(ticket.id, 'Awaiting Reply');
      }
      broadcastFn?.({
        type: 'ticket_agent_closed',
        ticketId: ticket.id,
        caseNumber: ticket.case_number,
        username: ticket.username || account.username,
        message: 'Agent closed the ticket — you can still reply to reopen it on Ubisoft\'s side.',
      });
      // Still fetch messages below so we capture any final agent message
    } else {
      const newStatus = mapUbiStatus(ubiStatus);
      if (newStatus && newStatus !== ticket.status) {
        console.log(`[MONITOR] Ticket #${ticket.case_number} status: ${ticket.status} → ${newStatus}`);
        updateTicketStatus(ticket.id, newStatus);
        broadcastFn?.({
          type: 'ticket_status_changed',
          ticketId: ticket.id,
          caseNumber: ticket.case_number,
          oldStatus: ticket.status,
          newStatus,
          username: ticket.username,
        });
      }
    }
  }

  // 2) Check for new messages
  const interResult = await getTicketInteractions(ticket.case_number, authOpts);
  if (interResult.success && interResult.data?.interactions) {
    const interactions = interResult.data.interactions;
    const latestLocal = getLatestMessage(ticket.id);
    const latestLocalTime = latestLocal?.created_at_remote || '1970-01-01T00:00:00';

    // Interactions are newest-first, so reverse to process oldest-first
    const sorted = [...interactions].reverse();

    let newMessageCount = 0;
    for (const msg of sorted) {
      // Only add messages newer than our latest stored one
      if (msg.createdAt > latestLocalTime) {
        insertMessage({
          ticket_id: ticket.id,
          comment_id: msg.id || null,
          body: msg.body || '',
          created_by: msg.createdBy || 'Unknown',
          created_at_remote: msg.createdAt || new Date().toISOString(),
          source: msg.source || 'CaseComment',
        });
        newMessageCount++;

        // If it's from the agent, send a notification
        if (msg.createdBy === 'Ubisoft Agent') {
          broadcastFn?.({
            type: 'new_agent_message',
            ticketId: ticket.id,
            caseNumber: ticket.case_number,
            username: ticket.username || account.username,
            messagePreview: (msg.body || '').substring(0, 120),
            createdAt: msg.createdAt,
          });
        }
      }
    }

    if (newMessageCount > 0) {
      console.log(`[MONITOR] Ticket #${ticket.case_number}: ${newMessageCount} new messages`);

      broadcastFn?.({
        type: 'new_messages',
        ticketId: ticket.id,
        caseNumber: ticket.case_number,
        count: newMessageCount,
      });
    }
  }
}

/**
 * Force-poll a single ticket immediately (for user-triggered refresh)
 */
export async function pollTicketNow(ticketId, broadcastFn) {
  const ticket = getTicketById(ticketId);
  if (!ticket || !ticket.case_number) return { success: false, error: 'Invalid ticket' };

  const proxy = getSetting('proxy_us');
  await pollSingleTicket(ticket, proxy, broadcastFn);
  return { success: true };
}

/**
 * Map Ubisoft status names to our internal status enum
 */
function mapUbiStatus(ubiStatus) {
  const lower = (ubiStatus || '').toLowerCase();

  if (lower === 'waiting') return 'Awaiting Reply';       // Agent replied, waiting on user
  if (lower === 'updated') return 'Awaiting Response';    // User replied, waiting on agent
  // NOTE: 'closed' is intentionally NOT mapped here — handled separately in pollSingleTicket
  if (lower === 'new' || lower === 'open') return 'Open';

  return null; // null = don't change
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
