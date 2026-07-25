"""
captcha_camoufox.py - reCAPTCHA Enterprise solver using Camoufox

Uses Camoufox (anti-detect Firefox via Playwright) to solve reCAPTCHA v3 Enterprise.
Navigates to the REAL Ubisoft help page - reCAPTCHA is already embedded there.
No proxy - real machine IP for maximum score.
"""
import asyncio
import json
import logging
import os
import sys

log = logging.getLogger("captcha_camoufox")

SITE_KEY = "6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt"
PAGE_URL = "https://www.ubisoft.com/en-us/help/account-recovery"

# JS injected into the real Ubisoft page to execute reCAPTCHA v3
EXECUTE_JS = """
async () => {
    // Wait for grecaptcha.enterprise to be available (it's already on the page)
    await new Promise((resolve, reject) => {
        let tries = 0;
        const interval = setInterval(() => {
            if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise) {
                clearInterval(interval);
                resolve();
            }
            if (++tries > 150) {
                clearInterval(interval);
                reject(new Error('grecaptcha not available after 15s'));
            }
        }, 100);
    });

    // Execute reCAPTCHA v3 with the AccountRecovery action
    return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('execute timeout (15s)')), 15000);
        grecaptcha.enterprise.ready(() => {
            grecaptcha.enterprise.execute('6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt', { action: 'AccountRecovery' })
                .then(token => { clearTimeout(timeout); resolve(token); })
                .catch(err => { clearTimeout(timeout); reject(err); });
        });
    });
}
"""


async def solve_captcha_camoufox(timeout: int = 90) -> dict:
    """
    Solve reCAPTCHA Enterprise using Camoufox (anti-detect Firefox).
    Navigates to the real Ubisoft help page and executes reCAPTCHA v3.
    Returns: {"success": True, "token": "..."} or {"success": False, "error": "..."}
    """
    try:
        from camoufox.async_api import AsyncCamoufox
    except ImportError:
        return {"success": False, "error": "camoufox not installed: pip install camoufox"}

    try:
        log.info("[camoufox] Launching anti-detect Firefox...")

        # Ensure X display is available
        os.environ.setdefault("DISPLAY", ":0")

        async with AsyncCamoufox(
            headless=False,   # Non-headless -> real browser signals -> high reCAPTCHA score
            geoip=True,       # Auto-match geolocation to real IP
            os="windows",     # Spoof Windows OS fingerprint
            humanize=True,    # Human-like mouse movement/timing
        ) as browser:
            page = await browser.new_page()

            log.info(f"[camoufox] Navigating to {PAGE_URL} ...")
            try:
                await page.goto(PAGE_URL, wait_until="domcontentloaded", timeout=45000)
            except Exception as e:
                log.warning(f"[camoufox] Page load warning (continuing): {e}")

            log.info("[camoufox] Waiting for reCAPTCHA Enterprise to be available...")

            # Wait up to 20s for reCAPTCHA to load on the real page
            try:
                await page.wait_for_function(
                    "() => typeof grecaptcha !== 'undefined' && !!grecaptcha.enterprise",
                    timeout=20000,
                )
            except Exception:
                # Fallback: inject script tag if not found on page
                log.warning("[camoufox] grecaptcha not found, injecting script tag...")
                await page.add_script_tag(
                    url=f"https://www.recaptcha.net/recaptcha/enterprise.js?render={SITE_KEY}"
                )
                try:
                    await page.wait_for_function(
                        "() => typeof grecaptcha !== 'undefined' && !!grecaptcha.enterprise",
                        timeout=15000,
                    )
                except Exception:
                    return {"success": False, "error": "grecaptcha never became available"}

            log.info("[camoufox] Executing reCAPTCHA (action=AccountRecovery)...")

            try:
                token = await page.evaluate(EXECUTE_JS)
            except Exception as e:
                return {"success": False, "error": f"execute failed: {e}"}

            if token and len(token) > 100:
                log.info(f"[camoufox] ✅ Token obtained ({len(token)} chars)")
                return {"success": True, "token": token}
            else:
                return {"success": False, "error": f"Empty/short token: {repr(token)[:50]}"}

    except Exception as e:
        log.error(f"[camoufox] Fatal error: {e}")
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    result = asyncio.run(solve_captcha_camoufox())
    print(json.dumps(result))
    sys.exit(0 if result.get("success") else 1)
