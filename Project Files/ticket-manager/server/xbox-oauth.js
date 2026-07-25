/**
 * Xbox OAuth — Microsoft OAuth → Xbox → Ubisoft token exchange
 *
 * Ported from eng_final (2)/ubisoft-xbox-linker/ (ms_auth.py, xbox_profile.py, ubisoft_exchange.py)
 *
 * Flow:
 *  1. Start Microsoft OAuth (get PPFT + urlPost from login.live.com)
 *  2. Login with email:password → get authorization code
 *  3. Handle "Stay signed in" / consent pages automatically
 *  4. Fetch Xbox Access Token (response_type=token)
 *  5. Exchange MS Access Token → Xbox User Token (user.auth.xboxlive.com)
 *  6. Ensure Xbox profile exists (accounts.xboxlive.com/accounts/create)
 *  7. Re-request Ubisoft OAuth code via the original auth URL
 *  8. POST code → connect.ubisoft.com to get Ubisoft accessToken
 *
 * Result: { success, accessToken, idOnPlatform, username, externalId }
 * The accessToken can be used directly in Ubi-Auth header instead of captcha flow.
 */

import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── Constants (from config.py) ─────────────────────────────────────────────

const UBISOFT_APP_CLIENT_ID = 'a6ba5fe8-6197-4710-a0a4-5fe8905826e8';
const UBISOFT_XBOX_CALLBACK = 'https://connect.ubisoft.com/xbox-callback';
const UBISOFT_TOKEN_URL = 'https://connect.ubisoft.com/v2/externalparties/public/microsoft/xbox/oauth/token';

const MS_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const MS_LOGIN_URL = 'https://login.live.com';
const MS_CONSENT_URL = 'https://account.live.com/Consent/Update';

const XBOX_USER_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XBOX_PROFILE_URL = 'https://accounts.xboxlive.com/accounts/create';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── Session helper ──────────────────────────────────────────────────────────

function createSession(proxy) {
  const cookieJar = new Map(); // domain → Map<name, value>

  function cookieHeader(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const [domain, cookies] of cookieJar) {
      if (host.endsWith(domain)) {
        for (const [k, v] of cookies) parts.push(`${k}=${v}`);
      }
    }
    return parts.join('; ');
  }

  function storeCookies(url, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const host = new URL(url).hostname;
    const domainKey = host.startsWith('www.') ? host.slice(4) : host;
    if (!cookieJar.has(domainKey)) cookieJar.set(domainKey, new Map());
    const jar = cookieJar.get(domainKey);
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        jar.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
      }
    }
  }

  const agentOpts = proxy ? { agent: new HttpsProxyAgent(`http://${proxy}`) } : {};

  async function request(url, options = {}) {
    const headers = {
      ...BROWSER_HEADERS,
      ...(options.headers || {}),
    };
    const cookStr = cookieHeader(url);
    if (cookStr) headers['Cookie'] = cookStr;

    const fetchOptions = {
      ...agentOpts,
      ...options,
      headers,
      redirect: 'manual',
    };

    let currentUrl = url;
    let response;
    const maxRedirects = 15;

    for (let i = 0; i < maxRedirects; i++) {
      response = await nodeFetch(currentUrl, fetchOptions);
      const setCookie = response.headers.raw()['set-cookie'];
      if (setCookie) storeCookies(currentUrl, setCookie);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
        fetchOptions.method = response.status === 307 || response.status === 308 ? (options.method || 'GET') : 'GET';
        delete fetchOptions.body;
      } else {
        break;
      }
    }

    response._finalUrl = currentUrl;
    return response;
  }

  return { request, cookieJar };
}

// ─── HTML Parsing Helpers ────────────────────────────────────────────────────

function parseServerData(html) {
  const m = html.match(/var\s+ServerData\s*=\s*(\{.*?\})\s*;/s);
  if (m) {
    try { return JSON.parse(m[1]); } catch { /* ignore */ }
  }
  return {};
}

function extractPPFT(sftTag) {
  const m = sftTag?.match(/value="([^"]+)"/);
  return m ? m[1] : '';
}

function extractCanary(html) {
  let m = html.match(/name="canary"\s*value="([^"]+)"/);
  if (m) return m[1];
  m = html.match(/"canary"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  const sd = parseServerData(html);
  return sd.canary || '';
}

function extractHiddenFields(html) {
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"/gi)) {
    fields[m[1]] = m[2];
  }
  for (const m of html.matchAll(/<input[^>]*value="([^"]*)"[^>]*name="([^"]*)"[^>]*type="hidden"/gi)) {
    fields[m[2]] = m[1];
  }
  return fields;
}

function extractFmHF(html) {
  const m = html.match(/<form[^>]*id="fmHF"[^>]*action="([^"]+)"[^>]*method="post"/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function parseQueryCode(url) {
  try {
    return new URL(url).searchParams.get('code');
  } catch {
    return null;
  }
}

// ─── Main Xbox OAuth Flow ────────────────────────────────────────────────────

/**
 * Authenticate via Microsoft → Xbox → Ubisoft OAuth (no captcha required)
 *
 * @param {string} email      - Microsoft account email
 * @param {string} password   - Microsoft account password
 * @param {string|null} proxy - Optional proxy (login:pass@host:port)
 * @returns {Promise<{success, accessToken?, idOnPlatform?, username?, externalId?, error?}>}
 */
export async function xboxOAuthLogin(email, password, proxy = null) {
  console.log(`[XBOX OAUTH] Starting for ${email} via ${proxy || 'direct'}`);
  const session = createSession(proxy);

  // ─── Step 1: Initialize OAuth, get login form ────────────────────────────

  const authUrl = `${MS_AUTHORIZE_URL}?client_id=${UBISOFT_APP_CLIENT_ID}&response_type=code&scope=XboxLive.signin XboxLive.offline_access&redirect_uri=${UBISOFT_XBOX_CALLBACK}`;

  let initResp = await session.request(authUrl, { method: 'GET' });
  const initUrl = initResp._finalUrl;
  const initHtml = await initResp.text();

  // Already got code (cached session)
  const immediateCode = parseQueryCode(initUrl);
  if (immediateCode) {
    console.log('[XBOX OAUTH] Got code immediately from init');
    return await exchangeCodeForUbiToken(immediateCode, session, authUrl);
  }

  const serverData = parseServerData(initHtml);
  const ppft = extractPPFT(serverData.sFTTag);
  const urlPost = serverData.urlPost;
  const urlGct = serverData.urlGetCredentialType;

  if (!ppft || !urlPost) {
    console.error('[XBOX OAUTH] Could not extract PPFT/urlPost from login page');
    return { success: false, error: 'Login page parse failed' };
  }

  // ─── Step 2: GetCredentialType (updates FlowToken) ───────────────────────

  let flowToken = ppft;
  if (urlGct) {
    try {
      const gctResp = await session.request(urlGct, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': serverData.urlLogin || MS_AUTHORIZE_URL },
        body: JSON.stringify({
          username: email,
          uaid: serverData.sUnauthSessionID || '',
          isOtherIdpSupported: true,
          checkPhones: false,
          isRemoteNGCSupported: true,
          isCookieBannerShown: false,
          isFidoSupported: false,
          flowToken: ppft,
          country: 'US',
        }),
      });
      const gctData = await gctResp.json();
      if (gctData.FlowToken) flowToken = gctData.FlowToken;
    } catch (e) {
      console.warn('[XBOX OAUTH] GCT request failed (non-fatal):', e.message);
    }
  }

  // ─── Step 3: POST credentials ────────────────────────────────────────────

  console.log(`[XBOX OAUTH] Posting credentials for ${email}...`);

  const loginResp = await session.request(urlPost, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': MS_LOGIN_URL,
      'Referer': serverData.urlLogin || MS_AUTHORIZE_URL,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: new URLSearchParams({
      login: email, loginfmt: email,
      type: '11', LoginOptions: '3',
      passwd: password, ps: '2',
      PPFT: flowToken, PPSX: 'Passport',
      NewUser: '1', fspost: '0',
      i21: '0', CookieDisclosure: '0',
      IsFidoSupported: '0', isSignupPost: '0',
    }).toString(),
  });

  const loginUrl = loginResp._finalUrl;

  if (loginResp.status === 429) {
    return { success: false, error: 'Microsoft rate limited (429)' };
  }

  // ─── Step 4: Resolve post-login chain ────────────────────────────────────

  const result = await resolvePostLogin(loginResp, loginUrl, session, authUrl, email, password);
  if (!result.success) return result;

  return await exchangeCodeForUbiToken(result.code, session, authUrl);
}

// ─── Resolve redirect chain after login POST ─────────────────────────────────

async function resolvePostLogin(resp, url, session, originalAuthUrl, email = null, password = null) {
  let currentResp = resp;
  let currentUrl = url;
  let html = await currentResp.text();

  for (let hop = 0; hop < 10; hop++) {
    // Got code?
    const code = parseQueryCode(currentUrl);
    if (code) {
      console.log(`[XBOX OAUTH] ✓ Auth code obtained (hop ${hop})`);
      return { success: true, code };
    }

    const sd = parseServerData(html);

    // Error in ServerData?
    if (sd.sErrTxt || sd.fHasError) {
      const msg = sd.sErrTxt || sd.sErrorMsg || 'Login error';
      console.error(`[XBOX OAUTH] ✗ ${msg}`);
      return { success: false, error: msg };
    }

    // Abuse / blocked?
    if (currentUrl.includes('live.com/Abuse') || currentUrl.includes('/Abuse?')) {
      return { success: false, error: 'Account blocked: abuse/suspicious activity' };
    }
    if (currentUrl.includes('live.com/recover')) {
      return { success: false, error: 'Account blocked: needs recovery' };
    }

    // Security proofs required?
    if (currentUrl.includes('proofs/Add') || currentUrl.includes('proofs/add')) {
      console.log('[XBOX OAUTH] Security proofs page — trying to skip...');
      const skipResult = await trySkipProofs(currentUrl, html, session, email, password);
      if (skipResult.success) {
        return skipResult;
      }
      return { success: false, error: 'Security proofs required (manual setup needed)' };
    }

    // Identity confirm?
    if (currentUrl.includes('identity/confirm')) {
      console.log('[XBOX OAUTH] Identity confirm page detected');

      // Try "LooksGood" button (security info review)
      if (html.includes('LooksGood') || html.includes('Is your security info accurate')) {
        const hidden = extractHiddenFields(html);
        const confirmResp = await session.request(currentUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': currentUrl },
          body: new URLSearchParams({ ...hidden, action: 'LooksGood' }).toString(),
        });
        currentUrl = confirmResp._finalUrl;
        html = await confirmResp.text();
        currentResp = confirmResp;
        continue;
      }

      // ── PRIMARY: Try IMAP email OTP verification FIRST ──────────────────
      // Microsoft's identity/confirm page often requires email OTP.
      // "skip" redirects to error.aspx?errcode=1078, so we must actually complete it.
      if (email && password) {
        console.log('[XBOX OAUTH] Attempting IMAP email OTP verification for identity/confirm...');
        const otpResult = await handleIdentityConfirmOTP(currentUrl, html, session, email, password);
        if (otpResult.success) {
          if (otpResult.code) {
            return { success: true, code: otpResult.code };
          }
          // Moved past identity/confirm — continue the loop
          currentUrl = otpResult.url;
          html = otpResult.html;
          continue;
        }
        console.warn(`[XBOX OAUTH] IMAP OTP verification failed: ${otpResult.error}`);
      }

      // ── FALLBACK: Try skip/continue actions ─────────────────────────────
      const hidden = extractHiddenFields(html);
      const formAction = html.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
      const formUrl = formAction ? formAction[1].replace(/&amp;/g, '&') : currentUrl;
      const resolvedFormUrl = formUrl.startsWith('http') ? formUrl : new URL(formUrl, currentUrl).href;

      for (const action of ['skip', 'continue', 'LooksGood', '']) {
        try {
          const body = { ...hidden };
          if (action) body.action = action;
          const confirmResp = await session.request(resolvedFormUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': currentUrl },
            body: new URLSearchParams(body).toString(),
          });
          const code = parseQueryCode(confirmResp._finalUrl);
          if (code) {
            console.log(`[XBOX OAUTH] ✓ Identity confirm bypassed with action="${action}"`);
            return { success: true, code };
          }
          if (!confirmResp._finalUrl.includes('identity/confirm') && !confirmResp._finalUrl.includes('error.aspx')) {
            currentUrl = confirmResp._finalUrl;
            html = await confirmResp.text();
            currentResp = confirmResp;
            console.log(`[XBOX OAUTH] Moved past identity/confirm with action="${action}"`);
            break;
          }
        } catch (e) {
          console.warn(`[XBOX OAUTH] identity/confirm action="${action}" failed: ${e.message}`);
        }
      }
      
      if (currentUrl.includes('identity/confirm')) {
        return { success: false, error: '2FA/identity verification required — IMAP and skip both failed' };
      }
      continue;
    }

    // Auto-submit fmHF form?
    const fmHFAction = extractFmHF(html);
    if (fmHFAction) {
      const hidden = extractHiddenFields(html);
      console.log(`[XBOX OAUTH] Auto-submit fmHF → ${fmHFAction.slice(0, 80)}`);
      const fmResp = await session.request(fmHFAction, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: new URLSearchParams(hidden).toString(),
      });
      currentUrl = fmResp._finalUrl;
      html = await fmResp.text();
      currentResp = fmResp;
      continue;
    }

    // KMSI (Stay Signed In) / post-login redirect?
    const hasUrlPost2 = sd.urlPost;
    const hasPpft2 = sd.sFTTag || sd.sFT;
    if (hasUrlPost2 && hasPpft2) {
      const ppft2 = extractPPFT(sd.sFTTag) || sd.sFT;
      console.log('[XBOX OAUTH] Confirming Stay Signed In...');
      const kmsiResp = await session.request(hasUrlPost2, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': MS_LOGIN_URL,
          'Referer': currentUrl,
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: new URLSearchParams({
          LoginOptions: '1', type: '28',
          ctx: sd.sCtx || '',
          hpgrequestid: sd.sessionId || '',
          PPFT: ppft2,
          i19: String(Date.now()),
        }).toString(),
      });
      currentUrl = kmsiResp._finalUrl;
      html = await kmsiResp.text();
      currentResp = kmsiResp;
      continue;
    }

    // Consent page?
    if (currentUrl.includes('Consent')) {
      const sdC = parseServerData(html);
      if (sdC.arrConsentInfoServerData || sdC.sCanary) {
        console.log('[XBOX OAUTH] Submitting consent...');
        const code = await submitConsent(sdC.sCanary || extractCanary(html), currentUrl, html, session);
        if (code) return { success: true, code };
        return { success: false, error: 'Consent submission failed' };
      }
    }

    // If no pattern matched — try getting Xbox access token directly and re-request Ubisoft code
    console.log('[XBOX OAUTH] No redirect pattern — trying Xbox token then re-requesting OAuth code...');
    break;
  }

  // Attempt to get Xbox access token and re-request Ubisoft authorization code
  const xboxToken = await fetchXboxAccessToken(session);
  if (xboxToken) {
    await ensureXboxProfile(xboxToken.accessToken, xboxToken.userHash, xboxToken.xboxToken, session);
    
    // Re-request the original Ubisoft auth URL — session cookies should now include Xbox consent
    console.log('[XBOX OAUTH] Re-requesting Ubisoft OAuth URL after Xbox token...');
    const reAuthResp = await session.request(originalAuthUrl, { method: 'GET' });
    let reAuthUrl = reAuthResp._finalUrl;
    let code = parseQueryCode(reAuthUrl);
    if (code) return { success: true, code };

    let reAuthHtml = await reAuthResp.text();

    // Try to resolve through multiple hops (consent, fmHF, KMSI)
    for (let hop = 0; hop < 5; hop++) {
      code = parseQueryCode(reAuthUrl);
      if (code) return { success: true, code };

      // Try fmHF auto-submit
      const fmHF = extractFmHF(reAuthHtml);
      if (fmHF) {
        const hidden = extractHiddenFields(reAuthHtml);
        console.log(`[XBOX OAUTH] Re-auth fmHF submit → ${fmHF.slice(0, 60)}`);
        const r = await session.request(fmHF, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(hidden).toString(),
        });
        reAuthUrl = r._finalUrl;
        code = parseQueryCode(reAuthUrl);
        if (code) return { success: true, code };
        reAuthHtml = await r.text();
        continue;
      }

      // Try consent
      if (reAuthUrl.includes('Consent')) {
        const canary = extractCanary(reAuthHtml);
        const consentCode = await submitConsent(canary, reAuthUrl, reAuthHtml, session);
        if (consentCode) return { success: true, code: consentCode };
      }

      // Try KMSI
      const sd = parseServerData(reAuthHtml);
      if (sd.urlPost && (sd.sFTTag || sd.sFT)) {
        const ppft = extractPPFT(sd.sFTTag) || sd.sFT;
        console.log('[XBOX OAUTH] Re-auth KMSI submit...');
        const r = await session.request(sd.urlPost, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': MS_LOGIN_URL },
          body: new URLSearchParams({
            LoginOptions: '1', type: '28',
            ctx: sd.sCtx || '', PPFT: ppft,
            i19: String(Date.now()),
          }).toString(),
        });
        reAuthUrl = r._finalUrl;
        code = parseQueryCode(reAuthUrl);
        if (code) return { success: true, code };
        reAuthHtml = await r.text();
        continue;
      }

      break; // No more patterns to try
    }
  }

  return { success: false, error: 'Could not obtain authorization code after login' };
}
// ─── Handle identity/confirm OTP via IMAP ────────────────────────────────────

/**
 * Handles the Microsoft identity/confirm page by:
 *  1. Parsing the available verification channels (email, phone, authenticator)
 *  2. Selecting the email channel if available
 *  3. Triggering the OTP send
 *  4. Reading the code via IMAP
 *  5. Submitting the code
 *
 * The identity/confirm page is a multi-step flow:
 *  - First page: choose verification method (email / phone / app)
 *  - Second page: enter the OTP code
 *
 * @returns {Promise<{success: boolean, code?: string, url?: string, html?: string, error?: string}>}
 */
async function handleIdentityConfirmOTP(confirmUrl, html, session, email, password) {
  try {
    const { IMAPCodeReader } = await import('./imap-reader.js');

    // Parse the identity/confirm page — look for verification channel data
    const sd = parseServerData(html);
    const hidden = extractHiddenFields(html);

    // ── Step 1: Look for verification channels ──────────────────────────
    // Microsoft's identity/confirm pages have various structures:
    //  a) Direct email/SMS selection links/buttons
    //  b) ServerData with proof channels
    //  c) Radio buttons for channel selection

    // Try to find email-related verification option
    // Common patterns: "Email ****@outlook.com", "Send code", email channel ID
    const emailChannelMatch = html.match(/data-channel="Email"/i)
      || html.match(/id="([^"]*email[^"]*channel[^"]*)"/i)
      || html.match(/data-proof="[^"]*Email[^"]*"/i);

    // Look for an "iProofAction" or similar hidden field indicating we can trigger email
    const proofOptions = html.match(/iProofOptions\s*=\s*(\d+)/);
    
    // Look for a "Send code" button or link
    const sendCodeMatch = html.match(/action="([^"]*(?:SendCode|sendcode|Proof\/Send|identity\/confirm)[^"]*)"/i)
      || html.match(/href="([^"]*(?:SendCode|sendcode)[^"]*)"/i);

    // Look for the masked email address on the page to confirm our email is the verification target
    const maskedEmail = email.replace(/^(.{2})[^@]*(@.*)$/, '$1****$2');
    const emailOnPage = html.includes(maskedEmail) || html.includes(email.split('@')[1]);

    if (!emailOnPage && !emailChannelMatch && !sendCodeMatch) {
      // Check if there's any OTP input field already visible (maybe email was already sent)
      if (html.includes('iOttText') || html.includes('otc') || html.match(/name="iOtt"/)) {
        console.log('[XBOX OAUTH] OTP input field found — email may have been sent automatically');
      } else {
        console.log('[XBOX OAUTH] No email verification option found on identity/confirm page');
        return { success: false, error: 'No email verification option available' };
      }
    }

    // ── Step 2: Trigger OTP email ───────────────────────────────────────
    const notBefore = new Date();
    
    // Try to select email channel and send the OTP
    const formAction = html.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
    const formUrl = formAction
      ? formAction[1].replace(/&amp;/g, '&')
      : confirmUrl;
    const resolvedFormUrl = formUrl.startsWith('http') ? formUrl : new URL(formUrl, confirmUrl).href;

    // Build the send-code request body
    // Microsoft's identity/confirm uses various field names depending on the flow
    const sendBody = { ...hidden };
    
    // Common Microsoft identity verification actions
    // "Email" channel selection + send action
    if (html.includes('iSelectProofAction')) {
      sendBody.iSelectProofAction = 'Email';
    }
    if (html.includes('iProofAction')) {
      sendBody.iProofAction = 'Email';
    }
    sendBody.action = 'send';

    console.log(`[XBOX OAUTH] Triggering OTP email to ${email}...`);
    const sendResp = await session.request(resolvedFormUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': confirmUrl,
      },
      body: new URLSearchParams(sendBody).toString(),
    });

    const sendUrl = sendResp._finalUrl;
    const sendHtml = await sendResp.text();

    // Check if we got redirected to a code entry page or got the code already
    const codeFromSend = parseQueryCode(sendUrl);
    if (codeFromSend) {
      console.log('[XBOX OAUTH] ✓ Got auth code immediately after send trigger');
      return { success: true, code: codeFromSend };
    }

    // ── Step 3: Read OTP from email via IMAP ────────────────────────────
    console.log(`[XBOX OAUTH] Reading OTP code from ${email} via IMAP...`);
    const reader = new IMAPCodeReader(email, password);
    try {
      const imapResult = await reader.getVerificationCode({
        senderFilter: 'microsoft',
        maxWaitSec: 45,
        pollIntervalMs: 3000,
        notBefore,
      });

      if (!imapResult.success || !imapResult.code) {
        console.warn(`[XBOX OAUTH] IMAP code retrieval failed: ${imapResult.error || 'no code found'}`);
        return { success: false, error: `IMAP code not found: ${imapResult.error || 'timeout'}` };
      }

      console.log(`[XBOX OAUTH] ✓ Got OTP code: ${imapResult.code}`);

      // ── Step 4: Submit the OTP code ─────────────────────────────────
      const codeHidden = extractHiddenFields(sendHtml);
      const codeFormMatch = sendHtml.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
      const codeFormUrl = codeFormMatch
        ? codeFormMatch[1].replace(/&amp;/g, '&')
        : sendUrl;
      const resolvedCodeUrl = codeFormUrl.startsWith('http') ? codeFormUrl : new URL(codeFormUrl, sendUrl).href;

      const submitBody = {
        ...codeHidden,
        iOttText: imapResult.code,
        iOtt: imapResult.code,
        otc: imapResult.code,
        type: '18',
        action: 'verify',
      };

      console.log(`[XBOX OAUTH] Submitting OTP code to ${resolvedCodeUrl.slice(0, 80)}...`);
      const submitResp = await session.request(resolvedCodeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': sendUrl,
        },
        body: new URLSearchParams(submitBody).toString(),
      });

      const resultUrl = submitResp._finalUrl;
      const resultCode = parseQueryCode(resultUrl);
      if (resultCode) {
        console.log('[XBOX OAUTH] ✓ Identity confirmed via email OTP!');
        return { success: true, code: resultCode };
      }

      // May need more redirect hops
      const resultHtml = await submitResp.text();

      // Check fmHF auto-submit (common after identity verification)
      const fmHF = extractFmHF(resultHtml);
      if (fmHF) {
        const fmHidden = extractHiddenFields(resultHtml);
        const fmResp = await session.request(fmHF, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fmHidden).toString(),
        });
        const fmCode = parseQueryCode(fmResp._finalUrl);
        if (fmCode) {
          console.log('[XBOX OAUTH] ✓ Identity confirmed via OTP + fmHF redirect');
          return { success: true, code: fmCode };
        }
        // Successfully moved past identity/confirm
        if (!fmResp._finalUrl.includes('identity/confirm') && !fmResp._finalUrl.includes('error.aspx')) {
          return { success: true, url: fmResp._finalUrl, html: await fmResp.text() };
        }
      }

      // Check if we at least moved past the identity/confirm page
      if (!resultUrl.includes('identity/confirm') && !resultUrl.includes('error.aspx')) {
        return { success: true, url: resultUrl, html: resultHtml };
      }

      console.warn(`[XBOX OAUTH] OTP submitted but still on identity page (url: ${resultUrl.slice(0, 100)})`);
      return { success: false, error: 'OTP submitted but verification not accepted' };

    } finally {
      reader.disconnect();
    }
  } catch (e) {
    console.warn(`[XBOX OAUTH] handleIdentityConfirmOTP error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ─── Try to skip proofs page, fall back to IMAP verification ─────────────────

async function trySkipProofs(proofsUrl, html, session, email = null, password = null) {
  // Step 1: Try to find a "skip" or "later" link/button
  const skipMatch = html.match(/href="([^"]*(?:skip|later|remind)[^"]*)"/i)
    || html.match(/action="([^"]*(?:skip|later)[^"]*)"/i);
  if (skipMatch) {
    const skipUrl = skipMatch[1].startsWith('http') ? skipMatch[1] : new URL(skipMatch[1], proofsUrl).href;
    const skipResp = await session.request(skipUrl, { method: 'GET' });
    const skipUrl2 = skipResp._finalUrl;
    const code = parseQueryCode(skipUrl2);
    if (code) return { success: true, code };
  }

  // Try POST to the form with a "skip" action
  const hidden = extractHiddenFields(html);
  const formMatch = html.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
  if (formMatch) {
    const formUrl = formMatch[1].replace(/&amp;/g, '&');
    const skipResp = await session.request(formUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...hidden, action: 'skip' }).toString(),
    });
    const code = parseQueryCode(skipResp._finalUrl);
    if (code) return { success: true, code };
  }

  // Step 2: If we have IMAP credentials, try email verification
  if (email && password) {
    console.log('[XBOX OAUTH] Skip failed — attempting IMAP email verification...');
    try {
      const { IMAPCodeReader } = await import('./imap-reader.js');

      // Look for a "send email" or "verify" button to trigger verification email
      const verifyMatch = html.match(/action="([^"]*(?:verify|send|email|code)[^"]*)"/i)
        || html.match(/href="([^"]*(?:verify|send|email|code)[^"]*)"/i);

      if (verifyMatch) {
        const verifyUrl = verifyMatch[1].startsWith('http')
          ? verifyMatch[1]
          : new URL(verifyMatch[1], proofsUrl).href;

        // Trigger sending the verification email
        const notBefore = new Date();
        const triggerResp = await session.request(verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': proofsUrl },
          body: new URLSearchParams({ ...hidden, action: 'send' }).toString(),
        });

        console.log(`[XBOX OAUTH] Verification email triggered (status: ${triggerResp.status})`);

        // Read the verification code from email via IMAP
        const reader = new IMAPCodeReader(email, password);
        try {
          const imapResult = await reader.getVerificationCode({
            senderFilter: 'microsoft',
            maxWaitSec: 60,
            pollIntervalMs: 3000,
            notBefore,
          });

          if (imapResult.success && imapResult.code) {
            console.log(`[XBOX OAUTH] ✓ Got verification code via IMAP: ${imapResult.code}`);

            // Submit the verification code
            const triggerHtml = await triggerResp.text();
            const codeHidden = extractHiddenFields(triggerHtml);
            const codeFormMatch = triggerHtml.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
            const codeFormUrl = codeFormMatch
              ? codeFormMatch[1].replace(/&amp;/g, '&')
              : proofsUrl;

            const submitResp = await session.request(codeFormUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': proofsUrl },
              body: new URLSearchParams({
                ...codeHidden,
                iOttText: imapResult.code,
                iOtt: imapResult.code,
                otc: imapResult.code,
                type: '18',
              }).toString(),
            });

            const resultUrl = submitResp._finalUrl;
            const resultCode = parseQueryCode(resultUrl);
            if (resultCode) {
              console.log('[XBOX OAUTH] ✓ Email verification successful');
              return { success: true, code: resultCode };
            }

            // May need more redirect hops
            const resultHtml = await submitResp.text();
            const fmHF = extractFmHF(resultHtml);
            if (fmHF) {
              const fmHidden = extractHiddenFields(resultHtml);
              const fmResp = await session.request(fmHF, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(fmHidden).toString(),
              });
              const fmCode = parseQueryCode(fmResp._finalUrl);
              if (fmCode) return { success: true, code: fmCode };
            }

            console.warn('[XBOX OAUTH] Code submitted but no auth code received — may need additional steps');
          } else {
            console.warn(`[XBOX OAUTH] IMAP code retrieval failed: ${imapResult.error}`);
          }
        } finally {
          reader.disconnect();
        }
      } else {
        console.warn('[XBOX OAUTH] No verification trigger button found on proofs page');
      }
    } catch (e) {
      console.warn(`[XBOX OAUTH] IMAP verification error: ${e.message}`);
    }
  }

  return { success: false };
}

// ─── Submit consent ──────────────────────────────────────────────────────────

async function submitConsent(canary, consentUrl, html, session) {
  const sd = parseServerData(html);
  const hidden = extractHiddenFields(html);
  const clientId = sd.sClientId
    || new URL(consentUrl).searchParams.get('client_id')
    || UBISOFT_APP_CLIENT_ID;
  const scopes = sd.sRawInputScopes || `${UBISOFT_APP_CLIENT_ID}:XboxLive.signin`;
  const sCanary = sd.sCanary ? sd.sCanary.replace(/\\u([0-9a-f]{4})/gi, (_, c) => String.fromCharCode(parseInt(c, 16))) : canary;

  const consentResp = await session.request(consentUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://account.live.com',
      'Referer': consentUrl,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: new URLSearchParams({
      ...hidden,
      ucaction: 'Yes',
      canary: sCanary,
      client_id: clientId,
      sRawInputScopes: scopes,
      scope: scopes,
      scopes: scopes,
    }).toString(),
  });

  const code = parseQueryCode(consentResp._finalUrl);
  if (code) return code;

  // May chain into another consent or fmHF
  const html2 = await consentResp.text();
  const fmHF = extractFmHF(html2);
  if (fmHF) {
    const hidden2 = extractHiddenFields(html2);
    const r2 = await session.request(fmHF, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(hidden2).toString(),
    });
    const code2 = parseQueryCode(r2._finalUrl);
    if (code2) return code2;
  }

  return null;
}

// ─── Xbox Access Token ────────────────────────────────────────────────────────

async function fetchXboxAccessToken(session) {
  console.log('[XBOX OAUTH] Fetching Microsoft Xbox Access Token...');
  const tokenUrl = `https://login.live.com/oauth20_authorize.srf?client_id=00000000402b5328&response_type=token&scope=service::user.auth.xboxlive.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf`;

  let resp = await session.request(tokenUrl, { method: 'GET' });
  let finalUrl = resp._finalUrl;

  // Try resolving intermediate pages (consent, fmHF, identity/confirm)
  for (let hop = 0; hop < 5; hop++) {
    if (finalUrl.includes('access_token=')) break;

    const html = await resp.text();

    // fmHF auto-submit?
    const fmHF = extractFmHF(html);
    if (fmHF) {
      const hidden = extractHiddenFields(html);
      console.log(`[XBOX OAUTH] Xbox token fmHF → ${fmHF.slice(0, 60)}`);
      resp = await session.request(fmHF, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(hidden).toString(),
      });
      finalUrl = resp._finalUrl;
      continue;
    }

    // identity/confirm — try skip
    if (finalUrl.includes('identity/confirm')) {
      console.log('[XBOX OAUTH] Xbox token identity/confirm — trying skip...');
      const hidden = extractHiddenFields(html);
      const formAction = html.match(/<form[^>]*action="([^"]+)"[^>]*method="post"/i);
      const formUrl = formAction ? formAction[1].replace(/&amp;/g, '&') : finalUrl;
      const resolvedUrl = formUrl.startsWith('http') ? formUrl : new URL(formUrl, finalUrl).href;
      for (const action of ['skip', 'continue', 'LooksGood', '']) {
        try {
          const body = { ...hidden };
          if (action) body.action = action;
          resp = await session.request(resolvedUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': finalUrl },
            body: new URLSearchParams(body).toString(),
          });
          finalUrl = resp._finalUrl;
          if (finalUrl.includes('access_token=') || !finalUrl.includes('identity/confirm')) {
            console.log(`[XBOX OAUTH] Xbox token identity/confirm bypassed with action="${action}"`);
            break;
          }
        } catch { /* try next action */ }
      }
      continue;
    }

    // Consent?
    if (finalUrl.includes('Consent')) {
      const canary = extractCanary(html);
      // For Xbox token, auto-consent
      const sd = parseServerData(html);
      const hidden = extractHiddenFields(html);
      const consentResp = await session.request(finalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://account.live.com' },
        body: new URLSearchParams({ ...hidden, ucaction: 'Yes', canary: sd.sCanary || canary }).toString(),
      });
      finalUrl = consentResp._finalUrl;
      resp = consentResp;
      continue;
    }

    // KMSI?
    const sd = parseServerData(html);
    if (sd.urlPost && (sd.sFTTag || sd.sFT)) {
      const ppft = extractPPFT(sd.sFTTag) || sd.sFT;
      resp = await session.request(sd.urlPost, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': MS_LOGIN_URL },
        body: new URLSearchParams({ LoginOptions: '1', type: '28', PPFT: ppft, i19: String(Date.now()) }).toString(),
      });
      finalUrl = resp._finalUrl;
      continue;
    }

    break; // No more patterns
  }

  if (finalUrl.includes('access_token=')) {
    const fragment = finalUrl.includes('#') ? finalUrl.split('#')[1] : '';
    const params = new URLSearchParams(fragment);
    const accessToken = params.get('access_token');
    if (accessToken) {
      console.log('[XBOX OAUTH] ✓ Xbox MS access token obtained');
      return await getXboxUserToken(accessToken, session);
    }
  }

  console.warn(`[XBOX OAUTH] ⚠ Could not get Xbox access token (final URL: ${finalUrl.slice(0, 100)})`);
  return null;
}

async function getXboxUserToken(msAccessToken, session) {
  try {
    const resp = await session.request(XBOX_USER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-xbl-contract-version': '1',
      },
      body: JSON.stringify({
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `t=${msAccessToken}`,
        },
      }),
    });
    const data = await resp.json();
    const xboxToken = data.Token;
    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (xboxToken) {
      console.log(`[XBOX OAUTH] ✓ Xbox User Token obtained. uhs=${userHash}`);
      return { accessToken: msAccessToken, xboxToken, userHash };
    }
  } catch (e) {
    console.warn('[XBOX OAUTH] Xbox user token error:', e.message);
  }
  return null;
}

async function ensureXboxProfile(msAccessToken, userHash, xboxToken, session) {
  if (!xboxToken || !userHash) return;
  try {
    const resp = await session.request(XBOX_PROFILE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `XBL3.0 x=${userHash};${xboxToken}`,
        'x-xbl-contract-version': '4',
      },
      body: JSON.stringify({ partnerOptInChoice: [], msftOptInChoice: false }),
    });
    if (resp.status === 409) console.log('[XBOX OAUTH] Xbox profile already exists — OK');
    else if (resp.status === 200 || resp.status === 201) console.log('[XBOX OAUTH] ✓ Xbox profile created');
    else console.warn(`[XBOX OAUTH] Profile creation: ${resp.status}`);
  } catch (e) {
    console.warn('[XBOX OAUTH] ensureXboxProfile error (non-fatal):', e.message);
  }
}

// ─── Exchange code for Ubisoft token ─────────────────────────────────────────

async function exchangeCodeForUbiToken(code, session, authUrl) {
  console.log(`[XBOX OAUTH] Exchanging code for Ubisoft token...`);

  try {
    const resp = await session.request(UBISOFT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': 'https://connect.ubisoft.com',
        'Referer': `${UBISOFT_XBOX_CALLBACK}?code=${code}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ code }),
    });

    console.log(`[XBOX OAUTH] Ubisoft exchange status: ${resp.status}`);

    if (resp.status === 200) {
      const data = await resp.json();
      console.log(`[XBOX OAUTH] ✓ Ubisoft token obtained!`);
      console.log(`[XBOX OAUTH]   username: ${data.username}, idOnPlatform: ${data.idOnPlatform}`);
      return {
        success: true,
        accessToken: data.accessToken,
        idOnPlatform: data.idOnPlatform,
        username: data.username,
        externalId: data.externalId,
        data,
      };
    }

    const errBody = await resp.text();
    console.error(`[XBOX OAUTH] Exchange failed: ${resp.status} — ${errBody.slice(0, 300)}`);
    return { success: false, error: `Exchange failed: ${resp.status}` };
  } catch (e) {
    console.error('[XBOX OAUTH] Exchange exception:', e.message);
    return { success: false, error: e.message };
  }
}
