// Ubisoft API Client — Ported from Python code_snippet.py
// Handles authentication, token refresh, and API request making

const LOGIN_APP_ID = '2c2d31af-4ee4-4049-85dc-00dc74aef88f';
const TICKET_APP_ID = '4391c956-8943-48eb-8859-07b0778f47b9';
const BASE_URL = 'https://public-ubiservices.ubi.com';

// Headers matching SDK/Uplay PC client for /v3/profiles/sessions authentication
const SDK_HEADERS = {
  'User-Agent': 'UbiServices_SDK_2020.Release.58_PC64_ansi_static',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Ubi-RequestedPlatformType': 'uplay',
  'Ubi-LocaleCode': 'en-US',
};

// Headers matching the exact working request from mitmproxy capture for CSHelp API
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Content-Type': 'application/json; charset=utf-8',
  'Referer': 'https://www.ubisoft.com/',
  'Origin': 'https://www.ubisoft.com',
  'Access-Control-Allow-Origin': '*',
};

/**
 * Make an authenticated API request to Ubisoft services
 */
async function makeRequest(endpoint, {
  method = 'GET',
  headers = null,
  params = null,
  jsonData = null,
  proxy = null,
  token = null,
  sessionId = null,
  appId = TICKET_APP_ID,
} = {}) {
  try {
    let url = `${BASE_URL}${endpoint}`;

    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const requestHeaders = headers || getAuthHeaders(token, sessionId, appId);

    const fetchOptions = {
      method,
      headers: requestHeaders,
    };

    if (jsonData && (method === 'POST' || method === 'PUT')) {
      fetchOptions.body = JSON.stringify(jsonData);
    }

    // Node.js native fetch with proxy support via env or agent
    // For proxy support, we'll use the proxy through a custom agent
    let fetchFn;
    if (proxy) {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const agent = new HttpsProxyAgent(`http://${proxy}`);
      fetchOptions.agent = agent;
      const nodeFetch = (await import('node-fetch')).default;
      fetchFn = nodeFetch;
    } else {
      const nodeFetch = (await import('node-fetch')).default;
      fetchFn = nodeFetch;
    }

    const response = await fetchFn(url, fetchOptions);

    console.log(`[UBI API] ${method} ${endpoint} -> ${response.status}`);

    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      let errorBody;
      try { errorBody = await response.json(); } catch { errorBody = null; }
      return { success: false, status: response.status, error: errorBody };
    }

    const responseData = await response.json();
    return { success: true, data: responseData };
  } catch (error) {
    console.error(`[UBI API] Request error:`, error.message);
    return { success: false, status: 0, error: error.message };
  }
}

/**
 * Build auth headers for Ubisoft API requests
 */
function getAuthHeaders(token, sessionId, appId = TICKET_APP_ID) {
  const headers = { ...BASE_HEADERS };
  headers['Ubi-AppId'] = appId;

  if (token) {
    headers['Authorization'] = `ubi_v1 t=${token}`;
  }
  if (sessionId) {
    headers['Ubi-SessionId'] = sessionId;
  }

  // Use the fixed genome ID from Ubisoft Help portal config
  headers['Ubi-GenomeId'] = '1a6f2698-1350-416e-b8e8-29d77fb86437';

  return headers;
}

/**
 * Elevate a LOGIN_APP_ID-scoped session to TICKET_APP_ID scope.
 * The mitmproxy capture showed the working ticket creation used a token
 * with AID = TICKET_APP_ID. This function converts an existing token.
 */
export async function elevateSession(existingToken, proxy = null) {
  try {
    const headers = {
      ...SDK_HEADERS,
      'Ubi-AppId': TICKET_APP_ID,
      'Authorization': `ubi_v1 t=${existingToken}`,
    };

    const result = await makeRequest('/v3/profiles/sessions', {
      method: 'POST',
      headers,
      jsonData: { rememberMe: false },
      proxy,
    });

    if (!result.success) {
      return { success: false, reason: 'ELEVATION_FAILED', status: result.status };
    }

    const data = result.data;
    console.log(`[UBI AUTH] Session elevated to TICKET scope (session: ${data.sessionId?.slice(0, 12)}...)`);

    return {
      success: true,
      data,
      token: data.ticket,
      sessionId: data.sessionId,
      profileId: data.profileId,
      userId: data.userId,
      expiration: data.expiration,
    };
  } catch (error) {
    console.error('[UBI AUTH] Elevation error:', error.message);
    return { success: false, reason: 'EXCEPTION', error: error.message };
  }
}

/**
 * Authenticate with Ubisoft using email:password (Basic Auth)
 * Retries up to maxRetries times
 */
export async function authenticate(email, password, proxy = null, maxRetries = 3) {
  const credentials = Buffer.from(`${email}:${password}`).toString('base64');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[UBI AUTH] Login attempt ${attempt}/${maxRetries} for ${email}`);

    try {
      const authHeaders = {
        ...SDK_HEADERS,
        'Ubi-AppId': LOGIN_APP_ID,
        'Authorization': `Basic ${credentials}`,
      };

      const result = await makeRequest('/v3/profiles/sessions', {
        method: 'POST',
        headers: authHeaders,
        jsonData: { rememberMe: true },
        proxy,
      });

      if (!result.success) {
        if (result.status === 401) {
          console.log(`[UBI AUTH] Invalid credentials for ${email}`);
          return { success: false, reason: 'INVALID' };
        }
        if (result.status === 429) {
          console.log(`[UBI AUTH] Rate limited, waiting before retry...`);
          await sleep(5000 * attempt);
          continue;
        }
        console.log(`[UBI AUTH] Attempt ${attempt} failed with status ${result.status}`);
        if (attempt < maxRetries) {
          await sleep(2000 * attempt);
          continue;
        }
        return { success: false, reason: 'API_ERROR', status: result.status };
      }

      const authData = result.data;
      console.log(`[UBI AUTH] Successfully authenticated ${email} (profile: ${authData.profileId})`);

      return {
        success: true,
        data: authData,
        token: authData.ticket,
        sessionId: authData.sessionId,
        profileId: authData.profileId,
        userId: authData.userId,
        expiration: authData.expiration,
      };
    } catch (error) {
      console.error(`[UBI AUTH] Attempt ${attempt} error:`, error.message);
      if (attempt < maxRetries) {
        await sleep(2000 * attempt);
        continue;
      }
      return { success: false, reason: 'EXCEPTION', error: error.message };
    }
  }

  return { success: false, reason: 'MAX_RETRIES' };
}

/**
 * Refresh a Ubisoft token using an existing valid ticket
 */
export async function refreshToken(ticketData, proxy = null) {
  try {
    if (!ticketData || !ticketData.ticket) {
      return { success: false, reason: 'NO_TICKET' };
    }

    const authHeaders = {
      ...SDK_HEADERS,
      'Ubi-AppId': LOGIN_APP_ID,
      'Authorization': `ubi_v1 t=${ticketData.ticket}`,
    };

    const result = await makeRequest('/v3/profiles/sessions', {
      method: 'POST',
      headers: authHeaders,
      jsonData: { rememberMe: false },
      proxy,
    });

    if (!result.success) {
      if (result.status === 401) {
        return { success: false, reason: 'INVALID_TOKEN' };
      }
      if (result.status === 429) {
        return { success: false, reason: 'RATE_LIMIT' };
      }
      return { success: false, reason: 'API_ERROR', status: result.status };
    }

    const newAuthData = result.data;
    console.log(`[UBI TOKEN] Token refreshed for profile ${newAuthData.profileId}`);

    return {
      success: true,
      data: newAuthData,
      token: newAuthData.ticket,
      sessionId: newAuthData.sessionId,
      profileId: newAuthData.profileId,
      userId: newAuthData.userId,
      expiration: newAuthData.expiration,
    };
  } catch (error) {
    console.error('[UBI TOKEN] Refresh error:', error.message);
    return { success: false, reason: 'EXCEPTION', error: error.message };
  }
}

// ─── Ticket API Operations ──────────────────────────────────────────────────

/**
 * Create an account recovery ticket
 */
export async function createTicket({
  token, sessionId, proxy,
  contactEmail, lostEmail, username,
  captchaToken,
  isXboxToken = false,
}) {
  // Payload must match the exact working format from mitmproxy capture (status 201)
  // CRITICAL: IDs must be STRINGS, linkedAccounts must have one empty entry
  const jsonData = {
    Case: {
      accountRecoveryReason: 'accountHackedOrTakenOver',
      ubiCategoryId: '420',
      platformId: '29',
      productInstallmentId: '50003',
      locale: 'en-us',
      contactChannel: 'Email',
      origin: 'API',
      emailAddress: contactEmail,
      lostEmailAddress: lostEmail,
      description: '',
      pcActivationKey: '',
      usernameVariations: [username],
      linkedAccounts: [{ platform: '', username: '' }],
    },
    attachments: [],
  };

  // Captcha token is REQUIRED by Ubisoft API — requests without it get errorCode 6010
  if (captchaToken) {
    jsonData.token = captchaToken;
  }

  // Xbox OAuth tokens use 'Bearer' format; Ubisoft ticket tokens use 'ubi_v1 t='
  const authHeader = isXboxToken ? `Bearer ${token}` : `ubi_v1 t=${token}`;

  // Debug: log what we're sending
  console.log('[TICKET API] Payload:', JSON.stringify(jsonData, null, 2));
  console.log('[TICKET API] Auth:', authHeader.slice(0, 30) + '...');

  const result = await makeRequest(
    '/v1/applications/global/cshelp/cases/api/account-recovery-cases',
    {
      method: 'POST',
      jsonData,
      proxy,
      sessionId,
      headers: {
        ...BASE_HEADERS,
        'Ubi-AppId': TICKET_APP_ID,
        'Authorization': authHeader,
        ...(sessionId ? { 'Ubi-SessionId': sessionId } : {}),
        'Ubi-GenomeId': '1a6f2698-1350-416e-b8e8-29d77fb86437',
      },
    }
  );

  if (!result.success) {
    console.log('[TICKET API] Error response:', JSON.stringify(result.error));
    return { success: false, error: result.error };
  }

  // Parse case number from response: "500Rm00001UybmAIAR|26358701"
  const fullId = result.data.item;
  const caseNumber = fullId ? fullId.split('|')[1] : null;

  return {
    success: true,
    caseNumber,
    caseIdFull: fullId,
  };
}

/**
 * Close a ticket
 */
export async function closeTicket(caseNumber, { token, sessionId, proxy }) {
  return makeRequest(
    `/v1/profiles/me/global/cshelp/cases/api/case/${caseNumber}`,
    { method: 'PUT', jsonData: { status: '2' }, proxy, token, sessionId }
  );
}

/**
 * Send a comment/reply to a ticket
 */
export async function sendComment(caseNumber, body, { token, sessionId, proxy }) {
  return makeRequest(
    `/v1/profiles/me/global/cshelp/cases/api/case/${caseNumber}/comment`,
    { method: 'POST', jsonData: { body }, proxy, token, sessionId }
  );
}

/**
 * Get ticket status
 */
export async function getTicketStatus(caseNumber, { token, sessionId, proxy }) {
  return makeRequest(
    `/v1/profiles/me/global/cshelp/cases/api/case/${caseNumber}`,
    { method: 'GET', proxy, token, sessionId }
  );
}

/**
 * Get ticket interactions (chat history)
 */
export async function getTicketInteractions(caseNumber, { token, sessionId, proxy }) {
  return makeRequest(
    `/v1/profiles/me/global/cshelp/cases/api/case/${caseNumber}/interactions/`,
    { method: 'GET', params: { offset: '0', limit: '9999' }, proxy, token, sessionId }
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export { makeRequest, getAuthHeaders, BASE_URL, TICKET_APP_ID, LOGIN_APP_ID };
