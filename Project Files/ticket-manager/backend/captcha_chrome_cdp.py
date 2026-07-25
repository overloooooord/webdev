"""
captcha_chrome_cdp.py - reCAPTCHA Enterprise solver using real Chrome + CDP

Launches google-chrome-stable with --remote-debugging-port, connects via
Playwright CDP, navigates to ubisoft.com/en-us/help, injects + executes
reCAPTCHA v3 Enterprise and submits the ticket creation request directly
from the browser context.

This is the **highest-priority** captcha method because:
1. Real Chrome with a real user profile -> highest reCAPTCHA score (≥0.7)
2. The API call is made from the page context -> no CORS/score issues
3. Trusted Types bypass: inject script + execute fetch in one evaluate()

Ported from: ticket-manager-py/auto_ticket.py (the WORKING version)

Requirements:
  - google-chrome-stable (or google-chrome / chromium) in PATH
  - playwright: pip install playwright
  - X11 display or Xvfb (DISPLAY env var)
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("captcha_chrome_cdp")

SITE_KEY = "6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt"
TICKET_APP_ID = "4391c956-8943-48eb-8859-07b0778f47b9"
GENOME_ID = "1a6f2698-1350-416e-b8e8-29d77fb86437"
PAGE_URL = "https://www.ubisoft.com/en-us/help"
CDP_PORT = 9222

# Persistent Chrome profile - keeps cookies/history between runs for better reCAPTCHA scores
_CHROME_PROFILE_DIR = str(Path(__file__).parent.parent / ".chrome_profile")


def _find_chrome() -> str | None:
    """Find Chrome binary on the system."""
    for name in ("google-chrome-stable", "google-chrome", "chromium-browser", "chromium"):
        path = shutil.which(name)
        if path:
            return path
    return None


def _build_ticket_js(
    token: str, session_id: str,
    contact_email: str, lost_email: str, username: str,
    reason: str = "accountHackedOrTakenOver",
) -> str:
    """Build JS that injects reCAPTCHA, waits for it, executes it, and POSTs the ticket.
    This is the exact approach from auto_ticket.py that WORKS - everything happens
    inside one page.evaluate() call in the real Chrome context.
    """
    # Escape single quotes in username
    safe_username = username.replace("'", "\\'")
    return f"""
    (async () => {{
        // Step 1: Inject reCAPTCHA script if not already present
        if (!document.querySelector('script[src*="recaptcha"]')) {{
            const s = document.createElement('script');
            s.src = 'https://www.google.com/recaptcha/enterprise.js?render={SITE_KEY}';
            document.head.appendChild(s);
        }}
        // Step 2: Wait for grecaptcha to load (max 30s)
        for (let i = 0; i < 60; i++) {{
            if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise &&
                typeof grecaptcha.enterprise.execute === 'function') break;
            await new Promise(r => setTimeout(r, 500));
        }}
        if (typeof grecaptcha === 'undefined' || !grecaptcha?.enterprise)
            return JSON.stringify({{error: 'no grecaptcha after 30s'}});
        // Step 3: Execute reCAPTCHA
        const captchaToken = await grecaptcha.enterprise.execute(
            '{SITE_KEY}', {{action: 'AccountRecovery'}});
        // Step 4: Submit ticket via fetch (from browser context = real Chrome fingerprint)
        const resp = await fetch(
            'https://public-ubiservices.ubi.com/v1/applications/global/cshelp/cases/api/account-recovery-cases', {{
            method: 'POST',
            headers: {{
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': 'ubi_v1 t={token}',
                'Ubi-AppId': '{TICKET_APP_ID}',
                'Ubi-GenomeId': '{GENOME_ID}',
                'Ubi-SessionId': '{session_id}',
            }},
            body: JSON.stringify({{
                Case: {{
                    accountRecoveryReason: '{reason}',
                    ubiCategoryId: '420', platformId: '29',
                    productInstallmentId: '50003', locale: 'en-us',
                    contactChannel: 'Email', origin: 'API',
                    emailAddress: '{contact_email}',
                    lostEmailAddress: '{lost_email}',
                    description: '', pcActivationKey: '',
                    usernameVariations: ['{safe_username}'],
                    linkedAccounts: [{{platform: '', username: ''}}],
                }},
                attachments: [],
                token: captchaToken,
            }}),
        }});
        const data = await resp.json();
        return JSON.stringify({{status: resp.status, data: data, tokenLen: captchaToken.length}});
    }})()
    """


def _build_captcha_only_js() -> str:
    """Build JS that only solves captcha (no ticket creation).
    Returns the captcha token for use by the Python backend.
    """
    return f"""
    (async () => {{
        if (!document.querySelector('script[src*="recaptcha"]')) {{
            const s = document.createElement('script');
            s.src = 'https://www.google.com/recaptcha/enterprise.js?render={SITE_KEY}';
            document.head.appendChild(s);
        }}
        for (let i = 0; i < 60; i++) {{
            if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise &&
                typeof grecaptcha.enterprise.execute === 'function') break;
            await new Promise(r => setTimeout(r, 500));
        }}
        if (typeof grecaptcha === 'undefined' || !grecaptcha?.enterprise)
            return JSON.stringify({{error: 'no grecaptcha after 30s'}});
        const token = await grecaptcha.enterprise.execute(
            '{SITE_KEY}', {{action: 'AccountRecovery'}});
        return JSON.stringify({{success: true, token: token, tokenLen: token.length}});
    }})()
    """


async def _launch_chrome_and_connect(chrome_bin: str):
    """Launch Chrome and connect via CDP. Returns (browser, page, chrome_proc)."""
    from playwright.async_api import async_playwright

    os.makedirs(_CHROME_PROFILE_DIR, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("DISPLAY", ":0")

    chrome_cmd = [
        chrome_bin,
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={_CHROME_PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--window-size=1920,1080",
        PAGE_URL,
    ]

    log.info(f"[chrome-cdp] Launching Chrome: {chrome_bin}")
    chrome_proc = subprocess.Popen(
        chrome_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    log.info(f"[chrome-cdp] Chrome PID: {chrome_proc.pid}")

    await asyncio.sleep(6)

    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    contexts = browser.contexts
    page = contexts[0].pages[0] if contexts[0].pages else await contexts[0].new_page()

    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
    except Exception:
        pass
    await asyncio.sleep(2)

    log.info("[chrome-cdp] Connected to Chrome, page ready")
    return pw, browser, page, chrome_proc


async def solve_captcha_chrome_cdp(timeout: int = 90) -> dict:
    """
    Solve reCAPTCHA Enterprise using real Chrome + CDP.
    Returns only the captcha token for the Python backend to use.

    Returns: {"success": True, "token": "..."} or {"success": False, "error": "..."}
    """
    chrome_bin = _find_chrome()
    if not chrome_bin:
        return {"success": False, "error": "Chrome not found in PATH"}

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"success": False, "error": "playwright not installed"}

    chrome_proc = None
    pw = None
    try:
        pw, browser, page, chrome_proc = await _launch_chrome_and_connect(chrome_bin)

        js = _build_captcha_only_js()
        log.info("[chrome-cdp] Executing reCAPTCHA solve...")
        raw = await page.evaluate(js)
        result = json.loads(raw) if isinstance(raw, str) else raw

        if result.get("error"):
            return {"success": False, "error": result["error"]}

        token = result.get("token", "")
        if token and len(token) > 100:
            log.info(f"[chrome-cdp] ✅ Token obtained ({len(token)} chars)")
            return {"success": True, "token": token}
        return {"success": False, "error": f"Empty/short token: {repr(token)[:50]}"}

    except Exception as e:
        log.error(f"[chrome-cdp] Fatal error: {e}")
        return {"success": False, "error": str(e)}
    finally:
        if chrome_proc:
            try:
                chrome_proc.terminate()
                chrome_proc.wait(timeout=5)
            except Exception:
                try:
                    chrome_proc.kill()
                except Exception:
                    pass
        if pw:
            try:
                await pw.stop()
            except Exception:
                pass


async def create_ticket_via_chrome_cdp(
    token: str, session_id: str,
    contact_email: str, lost_email: str, username: str,
    reason: str = "accountHackedOrTakenOver",
) -> dict:
    """
    Full ticket creation via Chrome CDP - solve captcha AND submit ticket
    in one browser evaluate() call. This is the most reliable method because
    everything happens in real Chrome's page context.

    Returns: {"success": True, "caseNumber": "...", "caseIdFull": "..."}
             or {"success": False, "error": "..."}
    """
    chrome_bin = _find_chrome()
    if not chrome_bin:
        return {"success": False, "error": "Chrome not found in PATH"}

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"success": False, "error": "playwright not installed"}

    chrome_proc = None
    pw = None
    try:
        pw, browser, page, chrome_proc = await _launch_chrome_and_connect(chrome_bin)

        js = _build_ticket_js(token, session_id, contact_email, lost_email, username, reason)
        log.info(f"[chrome-cdp] Executing full ticket creation for {username}...")
        raw = await page.evaluate(js)
        result = json.loads(raw) if isinstance(raw, str) else raw

        if result.get("error"):
            return {"success": False, "error": result["error"]}

        status = result.get("status")
        data = result.get("data", {})

        if status in (200, 201) and data.get("item"):
            parts = data["item"].split("|")
            case_id = parts[0]
            case_num = parts[1] if len(parts) > 1 else "?"
            log.info(f"[chrome-cdp] 🎉 TICKET CREATED! Case: {case_id} / #{case_num}")
            return {
                "success": True,
                "caseNumber": case_num,
                "caseIdFull": case_id,
            }
        else:
            err_code = data.get("errorCode", "?")
            log.error(f"[chrome-cdp] Ticket failed: status={status}, errorCode={err_code}")
            return {
                "success": False,
                "error": {"errorCode": err_code, "status": status, "data": data},
            }

    except Exception as e:
        log.error(f"[chrome-cdp] Fatal error: {e}")
        return {"success": False, "error": str(e)}
    finally:
        if chrome_proc:
            try:
                chrome_proc.terminate()
                chrome_proc.wait(timeout=5)
            except Exception:
                try:
                    chrome_proc.kill()
                except Exception:
                    pass
        if pw:
            try:
                await pw.stop()
            except Exception:
                pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    result = asyncio.run(solve_captcha_chrome_cdp())
    print(json.dumps(result))
