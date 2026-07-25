// CamoFox Browser Launcher — Opens CamoFox browser instances for PSN/Xbox verification
// CamoFox is an anti-detect browser based on Firefox. We launch it via CLI with proxy settings.
import { exec } from 'child_process';
import { getSetting } from './database.js';

// Track active browser instances so we can report status
const activeBrowsers = new Map(); // accountId -> { process, platform, startedAt }

/**
 * Launch CamoFox browser for a PSN account (with auto-login)
 * Opens the PSN login page and fills in credentials
 *
 * @param {Object} account - Account data from DB
 * @param {Function} broadcastFn - WebSocket broadcast
 * @returns {Object} Result with pid
 */
export function launchPSNBrowser(account, broadcastFn) {
  const proxy = getSetting('proxy_us') || getSetting('proxy_global');
  const camofoxPath = getSetting('camofox_path') || 'camofox';

  // Build the PSN login URL
  const loginUrl = 'https://my.account.sony.com/central/signin';

  try {
    // Launch CamoFox with proxy
    // CamoFox CLI typically accepts: camofox --proxy <proxy> --url <url>
    // The exact flags depend on your CamoFox version — adjust these if needed
    const proxyArg = proxy ? `--proxy http://${proxy}` : '';
    const cmd = `${camofoxPath} ${proxyArg} --url "${loginUrl}" --no-close`;

    console.log(`[CAMOFOX] Launching PSN browser for ${account.username}...`);
    console.log(`[CAMOFOX] Command: ${cmd}`);

    const child = exec(cmd, { detached: true });

    // Don't let the child process block our server from exiting
    child.unref();

    // Track the browser instance
    activeBrowsers.set(account.id, {
      process: child,
      platform: 'PSN',
      username: account.username,
      startedAt: new Date().toISOString(),
      pid: child.pid,
    });

    child.on('exit', (code) => {
      console.log(`[CAMOFOX] PSN browser for ${account.username} closed (code: ${code})`);
      activeBrowsers.delete(account.id);
      broadcastFn?.({
        type: 'browser_closed',
        accountId: account.id,
        platform: 'PSN',
        username: account.username,
      });
    });

    child.on('error', (err) => {
      console.error(`[CAMOFOX] Error launching PSN browser for ${account.username}:`, err.message);
      activeBrowsers.delete(account.id);
    });

    broadcastFn?.({
      type: 'browser_launched',
      accountId: account.id,
      platform: 'PSN',
      username: account.username,
      pid: child.pid,
    });

    return {
      success: true,
      pid: child.pid,
      message: `CamoFox PSN browser launched for ${account.username}. Log in manually — the browser will stay open until you close it.`,
    };
  } catch (err) {
    console.error(`[CAMOFOX] Launch error:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Launch CamoFox browser for an Xbox account (NO auto-login, just opens the browser)
 *
 * @param {Object} account - Account data from DB
 * @param {Function} broadcastFn - WebSocket broadcast
 * @returns {Object} Result with pid
 */
export function launchXboxBrowser(account, broadcastFn) {
  const proxy = getSetting('proxy_us') || getSetting('proxy_global');
  const camofoxPath = getSetting('camofox_path') || 'camofox';

  // Xbox login URL
  const loginUrl = 'https://login.live.com/';

  try {
    const proxyArg = proxy ? `--proxy http://${proxy}` : '';
    const cmd = `${camofoxPath} ${proxyArg} --url "${loginUrl}" --no-close`;

    console.log(`[CAMOFOX] Launching Xbox browser for ${account.username}...`);

    const child = exec(cmd, { detached: true });
    child.unref();

    activeBrowsers.set(account.id, {
      process: child,
      platform: 'XBL',
      username: account.username,
      startedAt: new Date().toISOString(),
      pid: child.pid,
    });

    child.on('exit', (code) => {
      console.log(`[CAMOFOX] Xbox browser for ${account.username} closed (code: ${code})`);
      activeBrowsers.delete(account.id);
      broadcastFn?.({
        type: 'browser_closed',
        accountId: account.id,
        platform: 'XBL',
        username: account.username,
      });
    });

    child.on('error', (err) => {
      console.error(`[CAMOFOX] Error launching Xbox browser:`, err.message);
      activeBrowsers.delete(account.id);
    });

    broadcastFn?.({
      type: 'browser_launched',
      accountId: account.id,
      platform: 'XBL',
      username: account.username,
      pid: child.pid,
    });

    return {
      success: true,
      pid: child.pid,
      message: `CamoFox Xbox browser launched for ${account.username}. Browser will stay open until you close it.`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get all active browser instances
 */
export function getActiveBrowsers() {
  const list = [];
  for (const [accountId, info] of activeBrowsers) {
    list.push({
      accountId,
      platform: info.platform,
      username: info.username,
      startedAt: info.startedAt,
      pid: info.pid,
    });
  }
  return list;
}

/**
 * Check if a browser is already open for an account
 */
export function isBrowserOpen(accountId) {
  return activeBrowsers.has(accountId);
}
