// Ticket Creator — Handles full lifecycle of ticket creation, closing, regeneration
import {
  getAccountById, insertTicket, updateTicketStatus, getTicketByAccountId,
  updateAccountAuth, insertMessage, getSetting, getTicketById,
} from './database.js';
import { createTicket, closeTicket, sendComment, refreshToken } from './ubisoft-api.js';
import { solveCaptcha } from './captcha-solver.js';
import { solveCaptchaBrowser } from './captcha-browser.js';
import { submitViaRealBrowser } from './form-bot.js';
import { xboxOAuthLogin } from './xbox-oauth.js';

/**
 * Create a new support ticket for an account.
 *
 * Flow:
 *  1. Try Xbox OAuth path first (if Microsoft credentials available) — NO CAPTCHA NEEDED
 *     - MS OAuth → Xbox token → Ubisoft token with TICKET_APP_ID scope
 *  2. Fallback: Refresh/re-login via Basic Auth + elevate session
 *  3. Solve reCAPTCHA via Capsolver (only for fallback Basic Auth path)
 *  4. Create ticket with elevated token
 *  5. Save ticket + initial message to DB
 */
export async function createTicketForAccount(accountId, broadcastFn) {
  const account = getAccountById(accountId);
  if (!account) return { success: false, error: 'Account not found' };

  if (account.login_status !== 'authenticated') {
    return { success: false, error: 'Account not authenticated. Login first.' };
  }

  if (!account.ubisoft_token) {
    return { success: false, error: 'No valid token. Refresh or re-login.' };
  }

  const proxy = getSetting('proxy_us');
  const contactEmail = account.platform_login_email || account.backup_email || account.login_email;
  const lostEmail = account.login_email;

  broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'auth' });

  // ── PRIMARY PATH: Xbox OAuth (no captcha required) ──────────────────────
  // If the account has Microsoft credentials, attempt Xbox OAuth first.
  // The Xbox OAuth flow produces a Ubisoft token with TICKET_APP_ID scope,
  // which allows ticket creation WITHOUT needing a reCAPTCHA token.
  if (account.platform === 'XBL' && account.platform_login_email && account.platform_login_password) {
    broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'xbox_oauth' });
    console.log(`[TICKET] Attempting Xbox OAuth path for ${account.username}...`);

    try {
      const xboxResult = await xboxOAuthLogin(
        account.platform_login_email,
        account.platform_login_password,
        proxy
      );

      if (xboxResult.success && xboxResult.accessToken) {
        console.log(`[TICKET] ✓ Xbox OAuth successful for ${account.username} — creating ticket without captcha`);

        // Elevate the Xbox OAuth token to TICKET_APP_ID scope
        const { elevateSession } = await import('./ubisoft-api.js');
        const elevResult = await elevateSession(xboxResult.accessToken, proxy);

        let ticketToken = xboxResult.accessToken;
        let ticketSessionId = null;

        if (elevResult?.success) {
          ticketToken = elevResult.token;
          ticketSessionId = elevResult.sessionId;
          console.log(`[TICKET] ✓ Xbox token elevated to TICKET scope`);
        } else {
          console.warn(`[TICKET] Xbox token elevation failed, using raw Xbox token`);
        }

        // Create ticket — NO captcha token needed with Xbox OAuth
        broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'creating_ticket' });
        const ticketResult = await createTicket({
          token: ticketToken,
          sessionId: ticketSessionId,
          proxy,
          contactEmail,
          lostEmail,
          username: account.username,
          captchaToken: null, // Not needed for Xbox OAuth path
        });

        if (ticketResult.success) {
          return await _saveTicketToDB(accountId, account, ticketResult, contactEmail, lostEmail, broadcastFn);
        }

        // If ticket creation failed with Xbox token, log and fall through to Basic Auth path
        console.warn(`[TICKET] Xbox OAuth ticket creation failed (${JSON.stringify(ticketResult.error)}), falling back to Basic Auth path...`);
      } else {
        console.warn(`[TICKET] Xbox OAuth login failed (${xboxResult.error}), falling back to Basic Auth path...`);
      }
    } catch (e) {
      console.warn(`[TICKET] Xbox OAuth exception (${e.message}), falling back to Basic Auth path...`);
    }
  }

  // ── FALLBACK PATH: Basic Auth + Capsolver captcha ───────────────────────
  let freshToken = account.ubisoft_token;
  let freshSessionId = account.session_id;

  try {
    const { refreshToken, authenticate } = await import('./ubisoft-api.js');
    const authData = account.auth_data_json ? JSON.parse(account.auth_data_json) : null;

    const refreshResult = authData?.ticket
      ? await refreshToken(authData, proxy)
      : null;

    if (refreshResult?.success) {
      freshToken = refreshResult.token;
      freshSessionId = refreshResult.sessionId;
      updateAccountAuth(accountId, {
        ubisoft_token: refreshResult.token,
        token_expiry: refreshResult.expiration,
        session_id: refreshResult.sessionId,
        profile_id: refreshResult.profileId,
        user_id: refreshResult.userId,
        auth_data_json: JSON.stringify(refreshResult.data),
      });
      console.log(`[TICKET] ✓ Token refreshed for ${account.username}`);
    } else {
      // Refresh failed — try full re-login
      console.warn(`[TICKET] Token refresh failed for ${account.username}, attempting re-login...`);
      const reloginResult = await authenticate(account.login_email, account.login_password, proxy);
      if (reloginResult?.success) {
        freshToken = reloginResult.token;
        freshSessionId = reloginResult.sessionId;
        updateAccountAuth(accountId, {
          ubisoft_token: reloginResult.token,
          token_expiry: reloginResult.expiration,
          session_id: reloginResult.sessionId,
          profile_id: reloginResult.profileId,
          user_id: reloginResult.userId,
          auth_data_json: JSON.stringify(reloginResult.data),
        });
        console.log(`[TICKET] ✓ Re-login successful for ${account.username}`);
      } else {
        console.warn(`[TICKET] Re-login also failed for ${account.username}, using existing token`);
      }
    }
  } catch (e) {
    console.warn(`[TICKET] Token refresh error (non-fatal): ${e.message}`);
  }

  // ── Step 2: Elevate session to TICKET_APP_ID scope (REQUIRED) ───────────
  // The mitmproxy capture confirmed the working request MUST use a TICKET_APP_ID token.
  // Without elevation, the token has AppId = LOGIN_APP_ID and Ubisoft WILL reject it.
  broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'elevating' });
  try {
    const { elevateSession } = await import('./ubisoft-api.js');
    const elevResult = await elevateSession(freshToken, proxy);
    if (elevResult?.success) {
      freshToken = elevResult.token;
      freshSessionId = elevResult.sessionId;
      console.log(`[TICKET] ✓ Session elevated to TICKET scope for ${account.username}`);
    } else {
      console.error(`[TICKET] ✗ Session elevation failed for ${account.username} — cannot create ticket without TICKET_APP_ID scope`);
      return { success: false, error: 'Session elevation to TICKET scope failed. The Ubisoft API requires a token with TICKET_APP_ID scope to create tickets.' };
    }
  } catch (e) {
    console.error(`[TICKET] ✗ Session elevation exception for ${account.username}: ${e.message}`);
    return { success: false, error: `Session elevation error: ${e.message}` };
  }

  // ── Step 3: Solve captcha (REQUIRED — Ubisoft always validates it) ───────
  // PRIMARY: Use headless browser to get a legitimate Google token
  // FALLBACK: Capsolver API (often rejected by Google Enterprise as 6010)
  broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'solving_captcha' });
  console.log(`[TICKET] Solving reCAPTCHA for ${account.username} (browser method)...`);

  let captchaResult = await solveCaptchaBrowser();
  if (!captchaResult.success) {
    console.warn(`[TICKET] Browser captcha failed (${captchaResult.error}), falling back to Capsolver...`);
    broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'solving_captcha_fallback' });
    captchaResult = await solveCaptcha();
  }
  if (!captchaResult.success) {
    console.error(`[TICKET] Captcha failed for ${account.username}: ${captchaResult.error}`);
    return { success: false, error: `Captcha failed: ${captchaResult.error}` };
  }
  console.log(`[TICKET] ✓ Captcha solved for ${account.username}`);

  // ── Step 4: Create ticket via Ubisoft API ────────────────────────────────
  broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'creating_ticket' });
  console.log(`[TICKET] Creating ticket for ${account.username}...`);

  const ticketResult = await createTicket({
    token: freshToken,
    sessionId: freshSessionId,
    proxy,
    contactEmail,
    lostEmail,
    username: account.username,
    captchaToken: captchaResult.token,
  });

  if (!ticketResult.success) {
    const errCode = ticketResult.error?.errorCode;
    if (errCode === 6010) {
      console.warn(`[TICKET] ✗ 6010 for ${account.username} — captcha token rejected. Trying form-bot (visible Chrome)...`);
      broadcastFn?.({ type: 'ticket_creating', accountId, username: account.username, step: 'form_bot_fallback' });

      try {
        const formBotResult = await submitViaRealBrowser(account, { broadcastFn });
        if (formBotResult.success) {
          console.log(`[TICKET] ✓ Form-bot succeeded for ${account.username}: Case #${formBotResult.caseNumber}`);
          return await _saveTicketToDB(accountId, account, formBotResult, contactEmail, lostEmail, broadcastFn);
        }
        console.error(`[TICKET] Form-bot also failed for ${account.username}: ${formBotResult.error}`);
        return { success: false, error: `Error 6010 + form-bot failed: ${formBotResult.error}` };
      } catch (fbErr) {
        console.error(`[TICKET] Form-bot exception for ${account.username}: ${fbErr.message}`);
        return { success: false, error: `Error 6010, form-bot error: ${fbErr.message}` };
      }
    }
    if (errCode === 6020) {
      return { success: false, error: `Error 6020: Account not found on Ubisoft's side.` };
    }
    if (errCode === 6500) {
      return { success: false, error: `Error 6500: Contact email flagged as suspicious.` };
    }
    if (errCode === 7050) {
      return { success: false, error: `Error 7050: Rate limit exceeded. Try again later.` };
    }
    console.error(`[TICKET] Create failed for ${account.username}:`, ticketResult.error);
    return { success: false, error: `Ticket creation failed: ${JSON.stringify(ticketResult.error)}` };
  }

  // ── Step 5: Save ticket + initial message to DB ──────────────────────────
  return await _saveTicketToDB(accountId, account, ticketResult, contactEmail, lostEmail, broadcastFn);
}

async function _saveTicketToDB(accountId, account, ticketResult, contactEmail, lostEmail, broadcastFn) {
  const dbResult = insertTicket({
    account_id: accountId,
    case_number: ticketResult.caseNumber,
    case_id_full: ticketResult.caseIdFull,
    status: 'Open',
    platform: account.platform,
    contact_email: contactEmail,
    lost_email: lostEmail,
  });

  const ticketId = dbResult.lastInsertRowid;

  // Save the initial submission as the first message so conversation history is complete
  insertMessage({
    ticket_id: ticketId,
    comment_id: null,
    body: `Ticket submitted — Account Recovery\n\nUsername: ${account.username}\nLost Email: ${lostEmail}\nContact Email: ${contactEmail}\nPlatform: ${account.platform}\nReason: Account hacked or taken over`,
    created_by: 'System',
    created_at_remote: new Date().toISOString(),
    source: 'TicketCreation',
  });

  console.log(`[TICKET] Created ticket #${ticketResult.caseNumber} for ${account.username}`);
  broadcastFn?.({
    type: 'ticket_created',
    accountId,
    ticketId,
    caseNumber: ticketResult.caseNumber,
    username: account.username,
  });

  return {
    success: true,
    ticketId,
    caseNumber: ticketResult.caseNumber,
    caseIdFull: ticketResult.caseIdFull,
  };
}

/**
 * Close a ticket (just close, no new ticket)
 */
export async function closeTicketById(ticketId, broadcastFn) {
  const ticket = getTicketById(ticketId);
  if (!ticket) return { success: false, error: 'Ticket not found' };

  const account = getAccountById(ticket.account_id);
  if (!account) return { success: false, error: 'Associated account not found' };

  const proxy = getSetting('proxy_us');

  const result = await closeTicket(ticket.case_number, {
    token: account.ubisoft_token,
    sessionId: account.session_id,
    proxy,
  });

  if (!result.success) {
    return { success: false, error: `Close failed: ${JSON.stringify(result.error)}` };
  }

  updateTicketStatus(ticketId, 'Completed');
  console.log(`[TICKET] Closed ticket #${ticket.case_number}`);

  broadcastFn?.({
    type: 'ticket_closed',
    ticketId,
    caseNumber: ticket.case_number,
    accountId: ticket.account_id,
  });

  return { success: true };
}

/**
 * Regenerate a ticket (close current + create new one)
 */
export async function regenerateTicket(ticketId, broadcastFn) {
  const ticket = getTicketById(ticketId);
  if (!ticket) return { success: false, error: 'Ticket not found' };

  // Step 1: Close current ticket
  console.log(`[TICKET] Regenerating: closing #${ticket.case_number}...`);
  const closeResult = await closeTicketById(ticketId, broadcastFn);
  if (!closeResult.success) {
    return { success: false, error: `Close step failed: ${closeResult.error}` };
  }

  // Small delay between close and create
  await sleep(2000);

  // Step 2: Create new ticket
  console.log(`[TICKET] Regenerating: creating new ticket for account ${ticket.account_id}...`);
  const createResult = await createTicketForAccount(ticket.account_id, broadcastFn);
  if (!createResult.success) {
    return { success: false, error: `Create step failed: ${createResult.error}`, closedOldTicket: true };
  }

  broadcastFn?.({
    type: 'ticket_regenerated',
    oldTicketId: ticketId,
    newTicketId: createResult.ticketId,
    newCaseNumber: createResult.caseNumber,
    accountId: ticket.account_id,
  });

  return {
    success: true,
    newTicketId: createResult.ticketId,
    newCaseNumber: createResult.caseNumber,
  };
}

/**
 * Send a reply/comment on a ticket
 */
export async function replyToTicket(ticketId, messageBody, broadcastFn) {
  const ticket = getTicketById(ticketId);
  if (!ticket) return { success: false, error: 'Ticket not found' };

  const account = getAccountById(ticket.account_id);
  if (!account) return { success: false, error: 'Associated account not found' };

  const proxy = getSetting('proxy_us');

  const result = await sendComment(ticket.case_number, messageBody, {
    token: account.ubisoft_token,
    sessionId: account.session_id,
    proxy,
  });

  if (!result.success) {
    return { success: false, error: `Reply failed: ${JSON.stringify(result.error)}` };
  }

  // Save message to DB
  insertMessage({
    ticket_id: ticketId,
    comment_id: result.data?.commentId || null,
    body: messageBody,
    created_by: 'Technical API',
    created_at_remote: new Date().toISOString(),
    source: 'CaseComment',
  });

  // Update ticket status to Awaiting Response (waiting for agent)
  updateTicketStatus(ticketId, 'Awaiting Response');

  console.log(`[TICKET] Reply sent on #${ticket.case_number}`);

  broadcastFn?.({
    type: 'message_sent',
    ticketId,
    caseNumber: ticket.case_number,
    body: messageBody,
  });

  return { success: true, commentId: result.data?.commentId };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
