// Token Manager — Automatic token refresh for all authenticated accounts
import { getAuthenticatedAccounts, updateAccountAuth, updateAccountLoginStatus, getAccountById, getAllAccounts, getSetting } from './database.js';
import { refreshToken, authenticate } from './ubisoft-api.js';

let refreshInterval = null;
let isRefreshing = false;

/**
 * Start the automatic token refresh loop
 */
export function startTokenManager(broadcastFn) {
  const refreshMinutes = parseInt(getSetting('token_refresh_minutes')) || 50;
  const intervalMs = refreshMinutes * 60 * 1000;

  console.log(`[TOKEN MGR] Starting token refresh loop (every ${refreshMinutes} minutes)`);

  // Initial refresh check
  setTimeout(() => refreshAllTokens(broadcastFn), 10000);

  // Periodic refresh
  refreshInterval = setInterval(() => refreshAllTokens(broadcastFn), intervalMs);
}

/**
 * Stop the token refresh loop
 */
export function stopTokenManager() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log('[TOKEN MGR] Token refresh loop stopped');
  }
}

/**
 * Refresh all authenticated account tokens sequentially
 * (not all at once to avoid rate limiting)
 */
async function refreshAllTokens(broadcastFn) {
  if (isRefreshing) {
    console.log('[TOKEN MGR] Already refreshing, skipping...');
    return;
  }

  isRefreshing = true;

  try {
    const accounts = getAuthenticatedAccounts();

    if (accounts.length === 0) {
      return;
    }

    console.log(`[TOKEN MGR] Refreshing tokens for ${accounts.length} accounts...`);
    const proxy = getSetting('proxy_us');
    let successCount = 0;
    let failCount = 0;

    for (const account of accounts) {
      try {
        // Check if token is within refresh window (expiry < 15 min away or unknown)
        const shouldRefresh = needsRefresh(account.token_expiry);

        if (!shouldRefresh) {
          continue;
        }

        const authData = account.auth_data_json ? JSON.parse(account.auth_data_json) : null;
        if (!authData || !authData.ticket) {
          console.log(`[TOKEN MGR] No auth data for ${account.username}, skipping`);
          continue;
        }

        const result = await refreshToken(authData, proxy);

        if (result.success) {
          updateAccountAuth(account.id, {
            ubisoft_token: result.token,
            token_expiry: result.expiration,
            session_id: result.sessionId,
            profile_id: result.profileId,
            user_id: result.userId,
            auth_data_json: JSON.stringify(result.data),
          });
          successCount++;
          console.log(`[TOKEN MGR] ✅ Refreshed token for ${account.username}`);
        } else {
          console.log(`[TOKEN MGR] ⚠️ Refresh failed for ${account.username}: ${result.reason} — attempting re-login...`);
          // Don't fall back to manual — try full re-login with credentials
          try {
            const reloginResult = await authenticate(account.login_email, account.login_password, proxy);
            if (reloginResult.success) {
              updateAccountAuth(account.id, {
                ubisoft_token: reloginResult.token,
                token_expiry: reloginResult.expiration,
                session_id: reloginResult.sessionId,
                profile_id: reloginResult.profileId,
                user_id: reloginResult.userId,
                auth_data_json: JSON.stringify(reloginResult.data),
              });
              successCount++;
              console.log(`[TOKEN MGR] ✅ Re-login successful for ${account.username}`);
              if (broadcastFn) broadcastFn({ type: 'account_authenticated', accountId: account.id, username: account.username });
            } else {
              console.log(`[TOKEN MGR] ❌ Re-login failed for ${account.username}: ${reloginResult.reason}`);
              // Only mark as failed if credentials themselves are bad
              failCount++;
              if (broadcastFn) broadcastFn({ type: 'token_expired', accountId: account.id, username: account.username });
            }
          } catch (reloginErr) {
            console.error(`[TOKEN MGR] Re-login error for ${account.username}:`, reloginErr.message);
            failCount++;
          }
        }

        // Stagger requests to avoid rate limits
        await sleep(2000);
      } catch (err) {
        console.error(`[TOKEN MGR] Error refreshing ${account.username}:`, err.message);
        failCount++;
      }
    }

    console.log(`[TOKEN MGR] Refresh complete: ${successCount} success, ${failCount} failed`);
  } catch (err) {
    console.error('[TOKEN MGR] Critical error in refresh cycle (recovered):', err.message);
  } finally {
    isRefreshing = false;
  }
}



/**
 * Refresh a single account's token
 */
export async function refreshSingleToken(accountId) {
  const account = getAccountById(accountId);
  if (!account) return { success: false, reason: 'ACCOUNT_NOT_FOUND' };

  const authData = account.auth_data_json ? JSON.parse(account.auth_data_json) : null;
  if (!authData || !authData.ticket) {
    return { success: false, reason: 'NO_AUTH_DATA' };
  }

  const proxy = getSetting('proxy_us');
  const result = await refreshToken(authData, proxy);

  if (result.success) {
    updateAccountAuth(account.id, {
      ubisoft_token: result.token,
      token_expiry: result.expiration,
      session_id: result.sessionId,
      profile_id: result.profileId,
      user_id: result.userId,
      auth_data_json: JSON.stringify(result.data),
    });
    return { success: true };
  }

  return { success: false, reason: result.reason };
}

/**
 * Bulk login all non-authenticated accounts
 */
export async function bulkLoginAll(broadcastFn) {
  const accounts = getAllAccounts().filter(a => a.login_status !== 'authenticated');
  const proxy = getSetting('proxy_us');
  let success = 0, failed = 0;

  console.log(`[BULK LOGIN] Starting for ${accounts.length} accounts...`);
  if (broadcastFn) broadcastFn({ type: 'bulk_login_start', total: accounts.length });

  for (const account of accounts) {
    try {
      const result = await authenticate(account.login_email, account.login_password, proxy);
      if (result.success) {
        updateAccountAuth(account.id, {
          ubisoft_token: result.token,
          token_expiry: result.expiration,
          session_id: result.sessionId,
          profile_id: result.profileId,
          user_id: result.userId,
          auth_data_json: JSON.stringify(result.data),
        });
        success++;
        console.log(`[BULK LOGIN] ✅ ${account.username}`);
        if (broadcastFn) broadcastFn({ type: 'account_authenticated', accountId: account.id, username: account.username });
      } else {
        failed++;
        console.log(`[BULK LOGIN] ❌ ${account.username}: ${result.reason}`);
        if (broadcastFn) broadcastFn({ type: 'account_login_failed', accountId: account.id, username: account.username, reason: result.reason });
      }
      await sleep(1500);
    } catch (err) {
      failed++;
      console.error(`[BULK LOGIN] Error for ${account.username}:`, err.message);
    }
  }

  console.log(`[BULK LOGIN] Done: ${success} success, ${failed} failed`);
  if (broadcastFn) broadcastFn({ type: 'bulk_login_complete', success, failed, total: accounts.length });
  return { success, failed, total: accounts.length };
}

/**
 * Check if a token needs refreshing (within 15 minutes of expiry)
 */
function needsRefresh(expiryStr) {
  if (!expiryStr) return true; // Unknown expiry, refresh to be safe

  try {
    const expiry = new Date(expiryStr);
    const now = new Date();
    const minutesUntilExpiry = (expiry.getTime() - now.getTime()) / (1000 * 60);
    return minutesUntilExpiry < 15;
  } catch {
    return true; // Can't parse, refresh to be safe
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
