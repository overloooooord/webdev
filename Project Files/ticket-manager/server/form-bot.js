/**
 * form-bot.js — Automated Ubisoft Account Recovery Ticket Submission
 *
 * FLOW:
 *  1. Launch visible Chrome (non-headless) with stealth + DISPLAY
 *  2. Navigate to Ubisoft Connect login → authenticate
 *  3. Navigate to Account Recovery wizard page
 *  4. Click through wizard: compromised → no access → contact us
 *  5. Fill form fields (contact email, lost email, username)
 *  6. Click Submit — intercept the POST /account-recovery-cases response
 *  7. Return { success, caseNumber, caseIdFull }
 */

import { getSetting } from './database.js';

const LOGIN_URL = 'https://connect.ubisoft.com/login?appId=4391c956-8943-48eb-8859-07b0778f47b9&lang=en-US&nextUrl=https://www.ubisoft.com/en-us/help/account-recovery';
const RECOVERY_PAGE = 'https://www.ubisoft.com/en-us/help/account-recovery';

/**
 * Submit an account recovery ticket through the real Ubisoft form.
 * @param {Object} account — account row from DB
 * @param {Object} opts — { broadcastFn? }
 */
export async function submitViaRealBrowser(account, opts = {}) {
  let browser = null;

  try {
    const puppeteer = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteer.use(StealthPlugin());

    const proxy = getSetting('proxy_us');

    // Force DISPLAY for non-headless mode
    process.env.DISPLAY = process.env.DISPLAY || ':0';

    console.log(`[FORM-BOT] Launching Chrome for ${account.username}...`);

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      '--lang=en-US',
      '--disable-features=IsolateOrigins,site-per-process',
    ];

    if (proxy) {
      launchArgs.push(`--proxy-server=http://${extractHostPort(proxy)}`);
    }

    browser = await puppeteer.launch({
      headless: false,
      args: launchArgs,
      defaultViewport: { width: 1280, height: 900 },
      timeout: 30000,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = (await browser.pages())[0] || await browser.newPage();

    if (proxy) {
      const creds = extractProxyCreds(proxy);
      if (creds) await page.authenticate(creds);
    }

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // ── Intercept API response to capture case number ─────────────────────
    let capturedCaseNumber = null;
    let capturedCaseId = null;
    let apiError = null;

    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('account-recovery-cases') && resp.request().method() === 'POST') {
        try {
          const text = await resp.text();
          let data;
          try { data = JSON.parse(text); } catch { return; }

          if (resp.status() === 200 || resp.status() === 201) {
            if (data.item) {
              const parts = data.item.split('|');
              capturedCaseId = parts[0];
              capturedCaseNumber = parts[1] || parts[0];
            } else {
              capturedCaseNumber = data.caseNumber || data.caseId || String(Date.now());
              capturedCaseId = data.caseId || capturedCaseNumber;
            }
            console.log(`[FORM-BOT] ✅ Case created: ${capturedCaseNumber}`);
          } else {
            apiError = `${data.errorCode || resp.status()}: ${data.message || JSON.stringify(data).slice(0, 120)}`;
            console.log(`[FORM-BOT] ❌ API error: ${apiError}`);
          }
        } catch (e) {
          console.warn(`[FORM-BOT] Response parse error: ${e.message}`);
        }
      }
    });

    // ── Step 1: Login via Ubisoft Connect ──────────────────────────────────
    console.log('[FORM-BOT] Logging into Ubisoft Connect...');
    opts.broadcastFn?.({ type: 'form_bot', accountId: account.id, step: 'login' });

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2000);
    await closeCookieBanner(page);

    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      const loginOk = await performLogin(page, account.login_email, account.login_password);
      if (loginOk) {
        console.log('[FORM-BOT] ✅ Login OK');
        loggedIn = true;
        await sleep(2000);
      } else {
        console.warn('[FORM-BOT] ⚠️ Login failed — continuing as guest');
      }
    } else {
      console.log('[FORM-BOT] Already logged in');
    }

    // ── Step 2: Navigate to Account Recovery page ─────────────────────────
    console.log('[FORM-BOT] Navigating to account-recovery wizard...');
    opts.broadcastFn?.({ type: 'form_bot', accountId: account.id, step: 'fill_form' });

    await page.goto(RECOVERY_PAGE, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {});
    await sleep(4000);
    await closeCookieBanner(page);

    // Wait for React SPA to render
    await page.waitForFunction(
      () => document.querySelectorAll('button, [role="button"], a').length > 2,
      { timeout: 15000 }
    ).catch(() => {});
    await sleep(1000);

    // Log current page state
    let pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
    console.log(`[FORM-BOT] Page state: ${pageText.slice(0, 200)}`);

    let formLoaded = false;

    // Check if form is already visible (some accounts get redirected directly)
    let visibleInputs = await page.$$('input:not([type="hidden"]):not([type="submit"]), textarea');
    if (visibleInputs.length > 0) {
      formLoaded = true;
      console.log(`[FORM-BOT] Form already visible (${visibleInputs.length} inputs)`);
    } else {
      // ── Wizard navigation ──────────────────────────────────────────────
      // Step A: "I think someone compromised my account"
      console.log('[FORM-BOT] Wizard A: clicking "compromised account"...');
      const clickedA = await clickWizardOption(page, [
        'compromised', 'hacked', 'taken over', 'think someone',
        'stolen', 'someone has', 'unauthorized', 'someone else has',
      ]);
      await sleep(2500);
      await closeCookieBanner(page);

      pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      console.log(`[FORM-BOT] After A: ${pageText.slice(0, 100)}`);

      // Step B: "Can you access your account?" → No
      console.log('[FORM-BOT] Wizard B: clicking "No / cannot access"...');
      await clickWizardOption(page, ['no', "can't access", 'cannot access', 'lost access', 'not able', "don't have access"]);
      await sleep(2000);

      pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      console.log(`[FORM-BOT] After B: ${pageText.slice(0, 100)}`);

      // Step C: "Contact us" / "Submit a case"
      console.log('[FORM-BOT] Wizard C: clicking "Contact us"...');
      await clickWizardOption(page, [
        'contact us', 'contact', 'submit a case', 'submit case',
        'open a case', 'get help', 'submit your case',
      ]);
      await sleep(3000);

      // Check for form after wizard
      let inputs3 = await page.$$('input:not([type="hidden"]):not([type="submit"]), textarea');
      if (inputs3.length === 0) {
        await page.waitForFunction(
          () => document.querySelectorAll('input:not([type="hidden"]), textarea').length > 0,
          { timeout: 10000 }
        ).catch(() => {});
        inputs3 = await page.$$('input:not([type="hidden"]):not([type="submit"]), textarea');
      }

      formLoaded = inputs3.length > 0;
      pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
      console.log(`[FORM-BOT] After wizard: ${inputs3.length} inputs | ${pageText.slice(0, 150)}`);
    }

    await sleep(1000);

    // ── Step 3: Fill the form ─────────────────────────────────────────────
    console.log('[FORM-BOT] Filling form fields...');
    const contactEmail = account.platform_login_email || account.backup_email || account.login_email;
    const platform = (account.platform || 'XBL').toUpperCase();

    const filled = await fillFormFields(page, {
      contactEmail,
      lostEmail: account.login_email,
      username: account.username,
      platform,
    });

    console.log(`[FORM-BOT] Form filled: ${filled} fields`);
    await sleep(1000);

    // ── Step 4: Submit ────────────────────────────────────────────────────
    console.log('[FORM-BOT] Submitting...');
    opts.broadcastFn?.({ type: 'form_bot', accountId: account.id, step: 'submitting' });

    const submitted = await clickSubmit(page);
    if (!submitted) {
      const allBtns = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .map(b => `[${b.tagName}] type=${b.type} text="${b.textContent.trim().slice(0, 40)}"`)
      );
      console.log('[FORM-BOT] All buttons on page:', allBtns.join(' | '));
      console.error('[FORM-BOT] No submit button found');
      return { success: false, error: 'Submit button not found — form may not have loaded correctly' };
    }

    // ── Step 5: Wait for API response ─────────────────────────────────────
    console.log('[FORM-BOT] Waiting for API response...');
    const deadline = Date.now() + 30000;
    while (!capturedCaseNumber && !apiError && Date.now() < deadline) {
      await sleep(500);
    }

    if (capturedCaseNumber) {
      console.log(`[FORM-BOT] ✅ Done! Case #${capturedCaseNumber}`);
      return { success: true, caseNumber: capturedCaseNumber, caseIdFull: capturedCaseId };
    }

    if (apiError) {
      return { success: false, error: `API error: ${apiError}` };
    }

    const finalText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    console.error(`[FORM-BOT] Timeout. Page text: ${finalText.slice(0, 200)}`);
    return { success: false, error: 'Timeout waiting for Ubisoft API response' };

  } catch (err) {
    console.error(`[FORM-BOT] Fatal error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    if (browser) {
      await sleep(1000);
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ─── Helper functions ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractHostPort(proxy) {
  const atIdx = proxy.lastIndexOf('@');
  return atIdx > 0 ? proxy.slice(atIdx + 1) : proxy;
}

function extractProxyCreds(proxy) {
  const atIdx = proxy.lastIndexOf('@');
  if (atIdx <= 0) return null;
  const [u, p] = proxy.slice(0, atIdx).split(':');
  return u && p ? { username: u, password: p } : null;
}

async function closeCookieBanner(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        '#onetrust-accept-btn-handler',
        'button[id*="accept"]',
        'button[class*="accept"]',
        'button[data-testid*="accept"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return; }
      }
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const acceptBtn = buttons.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === 'accept' || t === 'accept all' || t === 'i accept' || t === 'i accept cookies';
      });
      if (acceptBtn) acceptBtn.click();
    });
    await sleep(500);
  } catch { /* ignore */ }
}

async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      return !!(
        document.querySelector('[data-testid="user-menu"]') ||
        document.querySelector('[class*="userMenu"]') ||
        document.querySelector('[class*="UserMenu"]') ||
        document.querySelector('[class*="avatar"]') ||
        document.querySelector('.user-info') ||
        document.querySelector('[data-role="user-profile"]')
      );
    });
  } catch {
    return false;
  }
}

/**
 * Click a wizard option by matching any keyword in text content.
 * Tries buttons, links, list items, cards.
 */
async function clickWizardOption(page, keywords, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((kws) => {
      const selectors = [
        'button', '[role="button"]', 'a', 'li',
        '[class*="card"]', '[class*="Card"]',
        '[class*="item"]', '[class*="Item"]',
        '[class*="option"]', '[class*="Option"]',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || '').trim().toLowerCase();
          if (t.length < 2 || t.length > 200) continue;
          if (kws.some(k => t.includes(k.toLowerCase()))) {
            el.click();
            return t.slice(0, 60);
          }
        }
      }
      return null;
    }, keywords).catch(() => null);

    if (clicked) {
      console.log(`  [WIZARD] Clicked: "${clicked}"`);
      return true;
    }
    await sleep(400);
  }
  console.log(`  [WIZARD] Not found: ${keywords.join('/')}`);
  return false;
}

async function performLogin(page, email, password) {
  try {
    await page.waitForSelector(
      'input[type="email"], input[name="email"], #AuthEmail, input[name="Username"]',
      { timeout: 20000 }
    ).catch(() => {});

    const currentUrl = page.url();
    if (currentUrl.includes('ubisoft.com/') && !currentUrl.includes('connect.ubisoft.com/login')) {
      console.log('[FORM-BOT] Already redirected past login — assuming logged in');
      return true;
    }

    let emailInput = await page.$('input[type="email"], input[name="email"], #AuthEmail, input[name="Username"]').catch(() => null);

    if (!emailInput) {
      for (const frame of page.frames()) {
        try {
          emailInput = await frame.$('input[type="email"], input[name="email"]');
          if (emailInput) {
            await humanType(frame, emailInput, email);
            await sleep(400);
            const passInput = await frame.$('input[type="password"]').catch(() => null);
            if (passInput) {
              await humanType(frame, passInput, password);
              await sleep(400);
              const submitBtn = await frame.$('button[type="submit"]').catch(() => null);
              if (submitBtn) {
                await submitBtn.click().catch(() => {});
                await sleep(8000);
                const afterUrl = page.url();
                return !afterUrl.includes('connect.ubisoft.com/login');
              }
            }
            break;
          }
        } catch (frameErr) {
          if (frameErr.message.includes('detached') || frameErr.message.includes('Session closed')) {
            await sleep(5000);
            const afterUrl = page.url();
            return !afterUrl.includes('/login');
          }
        }
      }
      return false;
    }

    await humanType(page, emailInput, email);
    await sleep(400);

    const nextBtn = await page.$('button[type="submit"], #next-button, [data-testid="next"]').catch(() => null);
    if (nextBtn) { await nextBtn.click().catch(() => {}); await sleep(2000); }

    const passInput = await page.$('input[type="password"], input[name="password"], #AuthPassword').catch(() => null);
    if (!passInput) {
      await sleep(3000);
      return !page.url().includes('/login');
    }
    await humanType(page, passInput, password);
    await sleep(400);

    const loginBtn = await page.$('button[type="submit"], #AuthSubmit, [data-testid="submit"], .btn-primary, button.primary').catch(() => null);
    if (loginBtn) {
      await loginBtn.click().catch(() => {});
      await sleep(8000);
      return !page.url().includes('/login');
    }

    return false;
  } catch (e) {
    if (e.message.includes('detached') || e.message.includes('Session closed')) {
      await sleep(5000);
      try {
        const url = page.url();
        return !url.includes('/login');
      } catch { return false; }
    }
    console.error(`[FORM-BOT] performLogin error: ${e.message}`);
    return false;
  }
}

/**
 * Fill all form fields found on the page.
 * Returns count of filled fields.
 */
async function fillFormFields(page, { contactEmail, lostEmail, username, platform }) {
  let filled = 0;

  const inputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), select, textarea');
  console.log(`[FORM-BOT] Found ${inputs.length} form inputs`);

  for (const input of inputs) {
    try {
      const info = await input.evaluate(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: (el.name || '').toLowerCase(),
        id: (el.id || '').toLowerCase(),
        placeholder: (el.placeholder || '').toLowerCase(),
        ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
        value: el.value || '',
      }));

      const hint = `${info.name} ${info.id} ${info.placeholder} ${info.ariaLabel}`;

      if (info.tag === 'select') {
        if (hint.includes('platform') || hint.includes('console') || hint.includes('device')) {
          await page.evaluate((el, plat) => {
            for (const opt of el.options) {
              const t = opt.text.toLowerCase();
              if (plat === 'XBL' && (t.includes('xbox') || t.includes('xbl'))) {
                el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return;
              }
              if (plat === 'PSN' && (t.includes('playstation') || t.includes('psn'))) {
                el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return;
              }
            }
          }, input, platform);
          filled++;
        }
      } else if (info.tag !== 'button') {
        let value = null;
        if (hint.match(/contact.*email|new.*email|current.*email/) || (hint.includes('email') && !hint.match(/lost|old|origin|confirm/))) {
          value = contactEmail;
        } else if (hint.match(/lost|old.*email|original|account.*email|ubisoft.*email/)) {
          value = lostEmail;
        } else if (hint.match(/username|game.?name|player.?name|nickname/)) {
          value = username;
        }

        if (value && !info.value) {
          await input.click({ clickCount: 3 });
          await humanType(page, input, value);
          await sleep(300);
          filled++;
        }
      }
    } catch { /* skip */ }
  }

  // Strategy 2: fill by associated labels
  try {
    const labels = await page.$$('label');
    for (const label of labels) {
      const labelText = await label.evaluate(el => el.textContent.toLowerCase()).catch(() => '');
      const forAttr = await label.evaluate(el => el.getAttribute('for') || '').catch(() => '');

      let targetInput = null;
      if (forAttr) targetInput = await page.$(`#${CSS.escape(forAttr)}`).catch(() => null);
      if (!targetInput) {
        const handle = await label.evaluateHandle(el =>
          el.nextElementSibling?.matches('input,textarea,select') ? el.nextElementSibling :
          el.parentElement?.querySelector('input, textarea, select')
        ).catch(() => null);
        if (handle) {
          const exists = await handle.evaluate(el => !!el?.tagName).catch(() => false);
          if (exists) targetInput = handle;
        }
      }
      if (!targetInput) continue;

      const currentVal = await targetInput.evaluate(el => el.value || '').catch(() => '');
      if (currentVal) continue;

      let fillValue = null;
      if (labelText.match(/contact|new email/) || (labelText.includes('email') && !labelText.match(/lost|old|original/))) fillValue = contactEmail;
      else if (labelText.match(/lost|old|original|account email/)) fillValue = lostEmail;
      else if (labelText.match(/username|nickname|player/)) fillValue = username;

      if (fillValue) {
        await targetInput.click({ clickCount: 3 }).catch(() => {});
        await humanType(page, targetInput, fillValue).catch(() => {});
        await sleep(300);
        filled++;
      }
    }
  } catch { /* ignore */ }

  return filled;
}

async function clickSubmit(page) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    '[data-testid*="submit"]',
    '[data-testid*="Send"]',
    '[id*="submit"]',
    'button[class*="submit"]',
    'button[class*="Submit"]',
    'button[class*="primary"]',
  ];

  for (const sel of submitSelectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      const visible = await btn.isIntersectingViewport().catch(() => true);
      if (visible) {
        await btn.scrollIntoView().catch(() => {});
        await sleep(300);
        await btn.click().catch(() => {});
        console.log(`[FORM-BOT] Clicked submit: ${sel}`);
        return true;
      }
    }
  }

  const buttons = await page.$$('button, [role="button"]');
  const keywords = ['submit', 'send', 'create case', 'open case', 'submit case', 'start case'];
  for (const btn of buttons) {
    try {
      const text = await btn.evaluate(el => el.textContent.trim().toLowerCase());
      const visible = await btn.isIntersectingViewport().catch(() => true);
      if (visible && keywords.some(k => text.includes(k))) {
        await btn.scrollIntoView().catch(() => {});
        await sleep(300);
        await btn.click();
        console.log(`[FORM-BOT] Clicked by text: "${text}"`);
        return true;
      }
    } catch { /* skip */ }
  }

  return false;
}

async function humanType(ctx, element, text) {
  try {
    await element.click();
    await sleep(150);
    await element.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    for (const char of text) {
      await element.type(char, { delay: 40 + Math.random() * 60 });
    }
    await element.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
  } catch { /* ignore */ }
}
