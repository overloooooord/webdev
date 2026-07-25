// Capsolver reCAPTCHA Solver
// Solves reCAPTCHA v3 Enterprise tokens for Ubisoft ticket creation
import { getSetting } from './database.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';

const CAPSOLVER_API = 'https://api.capsolver.com';
const SITE_KEY = '6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt'; // Ubisoft help reCAPTCHA site key (2025)
const SITE_URL = 'https://www.ubisoft.com/en-us/help/account-recovery';

function getProxiedFetch() {
  const proxy = getSetting('proxy_us') || getSetting('proxy_global');
  if (proxy) {
    const agent = new HttpsProxyAgent(`http://${proxy}`);
    return (url, opts = {}) => nodeFetch(url, { ...opts, agent });
  }
  return nodeFetch;
}

/**
 * Solve a reCAPTCHA v3 Enterprise challenge via Capsolver API
 * @returns {Promise<{success: boolean, token?: string, error?: string}>}
 */
export async function solveCaptcha() {
  const apiKey = getSetting('captcha_api_key');
  if (!apiKey) {
    return { success: false, error: 'No Capsolver API key configured' };
  }

  const fetch = getProxiedFetch();

  try {
    console.log('[CAPTCHA] Submitting reCAPTCHA v3 Enterprise task to Capsolver...');

    // Step 1: Create task
    const createRes = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'ReCaptchaV3EnterpriseTaskProxyLess',
          websiteURL: SITE_URL,
          websiteKey: SITE_KEY,
          pageAction: 'AccountRecovery',
          minScore: 0.7,
        },
      }),
    });

    const createData = await createRes.json();

    if (createData.errorId !== 0) {
      console.error('[CAPTCHA] Create task failed:', createData);
      return { success: false, error: `Create failed: ${createData.errorDescription || createData.errorCode}` };
    }

    const taskId = createData.taskId;
    console.log(`[CAPTCHA] Task created: ${taskId}`);

    // Step 2: Poll for result (max 120 seconds)
    const maxWait = 120000;
    const pollInterval = 3000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await sleep(pollInterval);

      const resultRes = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });

      const resultData = await resultRes.json();

      if (resultData.errorId !== 0) {
        console.error('[CAPTCHA] Error:', resultData);
        return { success: false, error: `Solve failed: ${resultData.errorDescription || resultData.errorCode}` };
      }

      if (resultData.status === 'ready') {
        const token = resultData.solution?.gRecaptchaResponse;
        if (token) {
          console.log('[CAPTCHA] ✅ Solved successfully');
          return { success: true, token };
        }
        return { success: false, error: 'No token in solution' };
      }

      // status === 'processing' — keep waiting
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[CAPTCHA] Processing... (${elapsed}s)`);
    }

    return { success: false, error: 'Captcha solve timed out (120s)' };
  } catch (error) {
    console.error('[CAPTCHA] Exception:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check Capsolver balance
 */
export async function getCaptchaBalance() {
  const apiKey = getSetting('captcha_api_key');
  if (!apiKey) return { success: false, error: 'No API key' };

  try {
    const res = await getProxiedFetch()(`${CAPSOLVER_API}/getBalance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey }),
    });
    const data = await res.json();

    if (data.errorId === 0) {
      return { success: true, balance: parseFloat(data.balance) };
    }
    return { success: false, error: data.errorDescription || data.errorCode };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
