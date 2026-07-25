/**
 * Browser-Based reCAPTCHA Solver
 *
 * Uses Puppeteer + stealth to execute reCAPTCHA Enterprise with EXACT same 
 * configuration as the real Ubisoft Help page uses:
 *  - recaptcha.net (not google.com) 
 *  - render=explicit (not render=<siteKey>)
 *  - grecaptcha.enterprise.render() + execute() flow
 *  - Site key: 6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt
 *  - Action: "AccountRecovery"
 */

import { getSetting } from './database.js';

const SITE_KEY = '6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt';

/**
 * Solve reCAPTCHA by executing it in a real browser — matching Ubisoft's exact flow
 * @returns {Promise<{success: boolean, token?: string, error?: string}>}
 */
export async function solveCaptchaBrowser() {
  let browser = null;

  try {
    const puppeteer = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteer.use(StealthPlugin());

    // NOTE: Captcha is solved WITHOUT proxy — real machine IP gets much higher
    // reCAPTCHA Enterprise score. Proxy IPs (even residential) score poorly.
    console.log('[CAPTCHA-BROWSER] Launching visible Chrome (no proxy — real IP for high score)...');

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-extensions',
      '--window-size=1366,768',
      '--start-maximized',
    ];

    browser = await puppeteer.launch({
      headless: false,
      args: launchArgs,
      defaultViewport: { width: 1366, height: 768 },
      timeout: 30000,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = await browser.newPage();

    // No proxy authentication needed — we solve captcha on real IP

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    // ── Intercept requests: serve our lightweight page on ubisoft.com origin ──
    await page.setRequestInterception(true);
    let initialHtmlServed = false;

    page.on('request', (req) => {
      const url = req.url();
      const resourceType = req.resourceType();

      // Allow reCAPTCHA and Google services — use recaptcha.net like Ubisoft does
      if (url.includes('recaptcha') || url.includes('gstatic.com') || 
          url.includes('google.com') || url.includes('recaptcha.net')) {
        req.continue();
        return;
      }

      // For the initial page — serve our lightweight HTML
      if (resourceType === 'document' && !initialHtmlServed) {
        initialHtmlServed = true;
        req.respond({
          status: 200,
          contentType: 'text/html',
          // IMPORTANT: Use recaptcha.net and render=explicit — exactly like Ubisoft
          body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ubisoft Help - Account Recovery</title>
  <script src="https://www.recaptcha.net/recaptcha/enterprise.js?render=explicit"></script>
</head>
<body>
  <div id="recaptcha-container"></div>
  <script>
    window.__captchaReady = false;
    window.__captchaToken = null;
    window.__captchaError = null;
    window.__widgetId = null;

    // Wait for grecaptcha to be fully available
    function initRecaptcha() {
      try {
        // Render the widget explicitly (invisible mode) — like Ubisoft does
        window.__widgetId = grecaptcha.enterprise.render('recaptcha-container', {
          sitekey: '${SITE_KEY}',
          size: 'invisible',
          badge: 'inline',
        });
        window.__captchaReady = true;
        console.log('[CAPTCHA] reCAPTCHA rendered, widget ID:', window.__widgetId);
      } catch (e) {
        console.error('[CAPTCHA] render error:', e);
        window.__captchaError = 'render failed: ' + e.message;
      }
    }

    // Poll until grecaptcha.enterprise is available
    var checkInterval = setInterval(function() {
      if (typeof grecaptcha !== 'undefined' && 
          typeof grecaptcha.enterprise !== 'undefined' &&
          typeof grecaptcha.enterprise.render === 'function') {
        clearInterval(checkInterval);
        initRecaptcha();
      }
    }, 200);

    setTimeout(function() {
      clearInterval(checkInterval);
      if (!window.__captchaReady) {
        window.__captchaError = 'reCAPTCHA load timeout (20s)';
      }
    }, 20000);
  </script>
</body>
</html>`,
        });
        return;
      }

      // Block SPA navigations
      if (resourceType === 'document') {
        req.abort();
        return;
      }

      // Block heavy resources
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
        return;
      }

      // Allow everything else (XHR for reCAPTCHA validation, etc.)
      req.continue();
    });

    console.log('[CAPTCHA-BROWSER] Loading reCAPTCHA (explicit render) on ubisoft.com...');

    await page.goto('https://www.ubisoft.com/en-us/help/account-recovery', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for reCAPTCHA to be rendered
    await page.waitForFunction(
      () => window.__captchaReady === true || window.__captchaError !== null,
      { timeout: 25000 }
    );

    const captchaError = await page.evaluate(() => window.__captchaError);
    if (captchaError) {
      console.error(`[CAPTCHA-BROWSER] Setup error: ${captchaError}`);
      return { success: false, error: captchaError };
    }

    console.log('[CAPTCHA-BROWSER] reCAPTCHA rendered, executing with action=AccountRecovery...');

    // Execute reCAPTCHA using the widget ID from explicit render
    const token = await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('execute timeout (15s)')), 15000);
        try {
          // With render=explicit, execute() takes the widget ID, not the site key
          grecaptcha.enterprise.execute(window.__widgetId, { action: 'AccountRecovery' })
            .then(t => { clearTimeout(timeout); resolve(t); })
            .catch(e => { clearTimeout(timeout); reject(e); });
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      });
    });

    if (token && token.length > 100) {
      console.log(`[CAPTCHA-BROWSER] ✅ Token obtained (${token.length} chars)`);
      return { success: true, token };
    }

    console.error('[CAPTCHA-BROWSER] Invalid or empty token');
    return { success: false, error: 'Invalid token from browser' };

  } catch (error) {
    console.error('[CAPTCHA-BROWSER] Error:', error.message);
    return { success: false, error: error.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Split proxy string "user:pass@host:port" → ["user:pass", "host:port"]
 */
function splitProxy(proxy) {
  const atIdx = proxy.lastIndexOf('@');
  if (atIdx > 0) {
    return [proxy.slice(0, atIdx), proxy.slice(atIdx + 1)];
  }
  return [null, proxy];
}
