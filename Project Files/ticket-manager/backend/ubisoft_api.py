"""
ubisoft_api.py - Ubisoft API Client

Replaces server/ubisoft-api.js entirely.
Handles: Basic Auth, token refresh, session elevation (TICKET_APP_ID),
ticket CRUD via CSHelp API, captcha solving via 2Captcha / Rucaptcha.

All values (headers, IDs, payload) match the working mitmproxy capture:
  POST https://public-ubiservices.ubi.com/v1/applications/global/cshelp/cases/api/account-recovery-cases
  Response 201: {"item":"500Rm00001V4jQuIAJ|26363162","errorMessage":null,"statusCode":null}
"""
import base64
import json
import asyncio
import logging
from typing import Optional
import aiohttp

log = logging.getLogger("ubisoft_api")

# AppId rotation - when one AppId gets 429'd, cycle to the next
# Priority: newest first (less likely rate-limited)
LOGIN_APP_IDS = [
    "a467b4a5-d754-4e41-ac12-cb3379b21904",  # Newest - may require captcha for login
    "2c2d31af-4ee4-4049-85dc-00dc74aef88f",  # Standard Uplay PC client
    "e3d5ea9e-50bd-43b7-88bf-39794f4e3d40",  # Clean, no DataDome (may be 429'd)
]
LOGIN_APP_ID  = LOGIN_APP_IDS[0]  # Default = newest
_current_app_id_idx = 0  # Rotation index

TICKET_APP_ID = "4391c956-8943-48eb-8859-07b0778f47b9"
GENOME_ID     = "1a6f2698-1350-416e-b8e8-29d77fb86437"
BASE_URL       = "https://public-ubiservices.ubi.com"
SITE_KEY       = "6Ldk66MlAAAAAHy488w0hBi8wUVQgOoLqhJ8_jwt"
TWOCAP_API     = "https://api.2captcha.com"  # also works: https://rucaptcha.com
TWOCAP_IN      = f"{TWOCAP_API}/in.php"
TWOCAP_RES     = f"{TWOCAP_API}/res.php"

# SDK-style headers for /v3/profiles/sessions (matching working Uplay PC client)
# These are required for Basic Auth - browser headers cause 401!
SDK_HEADERS = {
    "User-Agent": "UbiServices_SDK_2020.Release.58_PC64_ansi_static",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Ubi-RequestedPlatformType": "uplay",
    "Ubi-LocaleCode": "en-US",
}

# Browser-style headers for CSHelp API (web portal style)
BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json; charset=utf-8",
    "Referer": "https://www.ubisoft.com/",
    "Origin": "https://www.ubisoft.com",
}


def _proxy_url(proxy: str | None) -> str | None:
    """Format proxy string for aiohttp: user:pass@host:port -> http://user:pass@host:port"""
    if not proxy:
        return None
    return f"http://{proxy}"


async def _request(
    endpoint: str,
    *,
    method: str = "POST",
    headers: dict | None = None,
    json_data: dict | None = None,
    proxy: str | None = None,
) -> dict:
    """Low-level request to Ubisoft API. Returns {success, data?, status?, error?}"""
    url = f"{BASE_URL}{endpoint}"
    hdrs = headers or BASE_HEADERS.copy()

    try:
        async with aiohttp.ClientSession() as session:
            kwargs = {"headers": hdrs, "proxy": _proxy_url(proxy)}
            if json_data and method in ("POST", "PUT"):
                kwargs["json"] = json_data

            async with session.request(method, url, **kwargs) as resp:
                text = await resp.text()
                log.info(f"{method} {endpoint} -> {resp.status}")

                try:
                    data = json.loads(text)
                except Exception:
                    data = text

                if resp.status in (200, 201, 202):
                    return {"success": True, "data": data, "status": resp.status}
                return {"success": False, "status": resp.status, "error": data}
    except Exception as e:
        log.error(f"Request error: {e}")
        return {"success": False, "status": 0, "error": str(e)}


def _get_login_app_id() -> str:
    """Get current login AppId (supports rotation on 429)."""
    return LOGIN_APP_IDS[_current_app_id_idx % len(LOGIN_APP_IDS)]


def _rotate_app_id():
    """Rotate to next LOGIN_APP_ID after 429/rate limit."""
    global _current_app_id_idx
    _current_app_id_idx = (_current_app_id_idx + 1) % len(LOGIN_APP_IDS)
    log.info(f"Rotated to LOGIN_APP_ID: {LOGIN_APP_IDS[_current_app_id_idx][:12]}...")


def _sdk_auth_headers(app_id: str | None = None) -> dict:
    """SDK-style headers for /v3/profiles/sessions (auth endpoints)."""
    return {**SDK_HEADERS, "Ubi-AppId": app_id or _get_login_app_id()}


def _auth_headers(token: str | None = None, session_id: str | None = None,
                  app_id: str = TICKET_APP_ID) -> dict:
    """Browser-style headers with ubi_v1 auth for CSHelp API."""
    hdrs = {**BASE_HEADERS, "Ubi-AppId": app_id, "Ubi-GenomeId": GENOME_ID}
    if token:
        hdrs["Authorization"] = f"ubi_v1 t={token}"
    if session_id:
        hdrs["Ubi-SessionId"] = session_id
    return hdrs


# -- Authentication -----------------------------------------------------------

async def authenticate(email: str, password: str, proxy: str | None = None,
                       max_retries: int = 3) -> dict:
    """Basic Auth login using SDK-style headers (matches Uplay PC client).
    Returns {success, token, sessionId, profileId, userId, expiration, data}"""
    creds = base64.b64encode(f"{email}:{password}".encode()).decode()

    for attempt in range(1, max_retries + 1):
        log.info(f"Login attempt {attempt}/{max_retries} for {email} (AppId: {_get_login_app_id()[:12]}...)")
        # Use SDK headers - browser headers cause 401 on this endpoint!
        hdrs = _sdk_auth_headers()
        hdrs["Authorization"] = f"Basic {creds}"

        result = await _request("/v3/profiles/sessions", headers=hdrs,
                                json_data={"rememberMe": True}, proxy=proxy)

        if result["success"]:
            d = result["data"]
            log.info(f"Authenticated {email} (profile: {d.get('profileId')})")
            return {
                "success": True, "data": d,
                "token": d.get("ticket"), "sessionId": d.get("sessionId"),
                "profileId": d.get("profileId"), "userId": d.get("userId"),
                "expiration": d.get("expiration"),
            }

        status = result.get("status", 0)
        if status == 401:
            return {"success": False, "reason": "INVALID"}
        if status == 429:
            _rotate_app_id()  # Try next AppId on rate limit
            log.warning(f"Rate limited, rotated AppId, waiting {5 * attempt}s...")
            await asyncio.sleep(5 * attempt)
            continue

        if attempt < max_retries:
            await asyncio.sleep(2 * attempt)

    return {"success": False, "reason": "MAX_RETRIES"}


async def refresh_token(auth_data: dict, proxy: str | None = None) -> dict:
    """Refresh an existing Ubisoft token."""
    ticket = auth_data.get("ticket")
    if not ticket:
        return {"success": False, "reason": "NO_TICKET"}

    hdrs = _sdk_auth_headers(LOGIN_APP_ID)
    hdrs["Authorization"] = f"ubi_v1 t={ticket}"
    result = await _request("/v3/profiles/sessions", headers=hdrs,
                            json_data={"rememberMe": False}, proxy=proxy)

    if result["success"]:
        d = result["data"]
        log.info(f"Token refreshed for {d.get('profileId')}")
        return {
            "success": True, "data": d,
            "token": d.get("ticket"), "sessionId": d.get("sessionId"),
            "profileId": d.get("profileId"), "userId": d.get("userId"),
            "expiration": d.get("expiration"),
        }

    status = result.get("status", 0)
    if status == 401:
        return {"success": False, "reason": "INVALID_TOKEN"}
    if status == 429:
        return {"success": False, "reason": "RATE_LIMIT"}
    return {"success": False, "reason": "API_ERROR", "status": status}


async def elevate_session(existing_token: str, proxy: str | None = None) -> dict:
    """Elevate LOGIN_APP_ID-scoped token to TICKET_APP_ID scope.
    Without this, Ubisoft returns 401 on ticket creation."""
    hdrs = _sdk_auth_headers(TICKET_APP_ID)
    hdrs["Authorization"] = f"ubi_v1 t={existing_token}"

    result = await _request("/v3/profiles/sessions", headers=hdrs,
                            json_data={"rememberMe": False}, proxy=proxy)
    if result["success"]:
        d = result["data"]
        log.info(f"Session elevated to TICKET scope (session: {d.get('sessionId', '')[:12]}...)")
        return {
            "success": True, "data": d,
            "token": d.get("ticket"), "sessionId": d.get("sessionId"),
            "profileId": d.get("profileId"), "userId": d.get("userId"),
            "expiration": d.get("expiration"),
        }
    return {"success": False, "reason": "ELEVATION_FAILED", "status": result.get("status")}


# -- Ticket Operations --------------------------------------------------------

async def get_support_id(token: str, session_id: str, proxy: str | None = None) -> dict:
    """GET /v1/profiles/me/global/cshelp/cases/api/support-id
    Returns the Ubi-SupportId which should be attached to ticket creation headers.
    Ported from ticket-manager-py/ubisoft_api.py."""
    hdrs = _auth_headers(token, session_id)
    return await _request(
        "/v1/profiles/me/global/cshelp/cases/api/support-id",
        method="GET", headers=hdrs, proxy=proxy,
    )

async def create_ticket(
    token: str, session_id: str, proxy: str | None,
    contact_email: str, lost_email: str, username: str,
    captcha_token: str,
    reason: str = "accountHackedOrTakenOver",
) -> dict:
    """Create an account recovery ticket.
    Payload matches the exact working mitmproxy capture (status 201).

    Token types:
    - ubi_v1 ticket from Basic Auth -> used directly with ubi_v1 t= prefix
    - Xbox OAuth accessToken from connect.ubisoft.com -> also a ubi_v1 token,
      used directly without Bearer exchange
    """

    # The connect.ubisoft.com accessToken is already a ubi_v1-compatible token.
    # No Bearer exchange needed - just use it directly as ubi_v1.
    payload = {
        "Case": {
            "accountRecoveryReason": reason,
            "ubiCategoryId": "420",
            "platformId": "29",
            "productInstallmentId": "50003",
            "locale": "en-us",
            "contactChannel": "Email",
            "origin": "API",
            "emailAddress": contact_email,
            "lostEmailAddress": lost_email,
            "description": "",
            "pcActivationKey": "",
            "usernameVariations": [username],
            "linkedAccounts": [{"platform": "", "username": ""}],
        },
        "attachments": [],
    }

    if captcha_token:
        payload["token"] = captcha_token

    # Always use ubi_v1 auth - both Basic Auth tokens and Xbox OAuth tokens
    # from connect.ubisoft.com are ubi_v1 compatible
    hdrs = _auth_headers(token, session_id, TICKET_APP_ID)

    # Attach Ubi-SupportId if available (improves ticket creation reliability)
    try:
        sup_res = await get_support_id(token, session_id, proxy)
        if sup_res.get("success") and isinstance(sup_res.get("data"), dict):
            sup_id = sup_res["data"].get("supportId") or sup_res["data"].get("id")
            if sup_id:
                hdrs["Ubi-SupportId"] = str(sup_id)
                log.info(f"Attached Ubi-SupportId: {sup_id}")
    except Exception as e:
        log.warning(f"Could not fetch Support ID (non-fatal): {e}")

    log.info(f"Creating ticket for {username} (ubi_v1, token_len={len(token)})")
    result = await _request(
        "/v1/applications/global/cshelp/cases/api/account-recovery-cases",
        headers=hdrs, json_data=payload, proxy=proxy,
    )

    if not result["success"]:
        log.error(f"Ticket creation failed: {result.get('error')}")
        return {"success": False, "error": result.get("error")}

    full_id = result["data"].get("item", "")
    parts = full_id.split("|")
    case_number = parts[1] if len(parts) > 1 else parts[0]

    log.info(f"Ticket created: {case_number}")
    return {"success": True, "caseNumber": case_number, "caseIdFull": full_id}


async def close_ticket(case_number: str, token: str, session_id: str, proxy: str | None) -> dict:
    hdrs = _auth_headers(token, session_id)
    return await _request(f"/v1/profiles/me/global/cshelp/cases/api/case/{case_number}",
                          method="PUT", headers=hdrs, json_data={"status": "2"}, proxy=proxy)


async def send_comment(case_number: str, body: str, token: str, session_id: str, proxy: str | None) -> dict:
    hdrs = _auth_headers(token, session_id)
    return await _request(f"/v1/profiles/me/global/cshelp/cases/api/case/{case_number}/comment",
                          headers=hdrs, json_data={"body": body}, proxy=proxy)


async def get_ticket_status(case_number: str, token: str, session_id: str, proxy: str | None) -> dict:
    hdrs = _auth_headers(token, session_id)
    return await _request(f"/v1/profiles/me/global/cshelp/cases/api/case/{case_number}",
                          method="GET", headers=hdrs, proxy=proxy)


async def get_ticket_interactions(case_number: str, token: str, session_id: str, proxy: str | None) -> dict:
    hdrs = _auth_headers(token, session_id)
    url = f"/v1/profiles/me/global/cshelp/cases/api/case/{case_number}/interactions/?offset=0&limit=9999"
    return await _request(url, method="GET", headers=hdrs, proxy=proxy)


# -- Captcha Solvers -----------------------------------------------

async def solve_captcha_chrome_cdp() -> dict:
    """PRIORITY 0: Solve reCAPTCHA using real Chrome + CDP.
    Launches google-chrome-stable with remote debugging, connects via Playwright CDP.
    Real Chrome profile -> highest reCAPTCHA score (≥0.7).
    Ported from ticket-manager-py/auto_ticket.py.
    """
    try:
        from .captcha_chrome_cdp import solve_captcha_chrome_cdp as _solve
        return await _solve()
    except Exception as e:
        log.warning(f"Chrome CDP import/run error: {e}")
        return {"success": False, "error": str(e)}


async def solve_captcha_camoufox() -> dict:
    """PRIORITY 1: Solve reCAPTCHA using Camoufox anti-detect Firefox.
    Camoufox randomizes browser fingerprints -> high Google reCAPTCHA score.
    Solved without proxy -> real machine IP for maximum score.
    """
    try:
        from .captcha_camoufox import solve_captcha_camoufox as _solve
        return await _solve()
    except Exception as e:
        log.warning(f"Camoufox import/run error: {e}")
        return {"success": False, "error": str(e)}


async def solve_captcha_browser_python() -> dict:
    """SECONDARY: Solve reCAPTCHA using Node.js Puppeteer (non-headless, DISPLAY=:0)."""
    import shutil, asyncio as _asyncio, json, os
    from pathlib import Path as _Path

    node_bin = shutil.which("node") or shutil.which("nodejs")
    if not node_bin:
        return {"success": False, "error": "Node.js not installed"}

    script = _Path(__file__).parent.parent / "server" / "run-captcha-cli.js"
    if not script.exists():
        return {"success": False, "error": "run-captcha-cli.js missing"}

    env = os.environ.copy()
    env["DISPLAY"] = env.get("DISPLAY", ":0")  # ensure X display is set

    try:
        proc = await _asyncio.create_subprocess_exec(
            node_bin, str(script),
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.PIPE,
            cwd=str(script.parent.parent),
            env=env,
        )
        stdout, stderr = await _asyncio.wait_for(proc.communicate(), timeout=60)
        out = stdout.decode().strip()
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    res = json.loads(line)
                    if res.get("success"):
                        return res
                except Exception:
                    pass
    except Exception as e:
        log.warning(f"solve_captcha_browser_python error: {e}")

    return {"success": False, "error": "Browser captcha failed"}


async def solve_captcha_2captcha(api_key: str, proxy: str | None = None) -> dict:
    """Solve reCAPTCHA v3 Enterprise.
    Chain: 1) Chrome CDP -> 2) Camoufox -> 3) Node.js Puppeteer -> 4) 2Captcha API
    """
    # 0. TOP PRIORITY: Chrome CDP (real Chrome, highest score ≥0.7)
    log.info("Trying Chrome CDP (real Chrome, highest priority)...")
    chrome_res = await solve_captcha_chrome_cdp()
    if chrome_res.get("success"):
        log.info("Captcha solved via Chrome CDP (priority 0)")
        return chrome_res
    log.warning(f"Chrome CDP failed: {chrome_res.get('error')}, trying Camoufox...")

    # 1. SECONDARY: Camoufox anti-detect Firefox
    log.info("Trying Camoufox (anti-detect Firefox)...")
    camoufox_res = await solve_captcha_camoufox()
    if camoufox_res.get("success"):
        log.info("Captcha solved via Camoufox (priority 1)")
        return camoufox_res
    log.warning(f"Camoufox failed: {camoufox_res.get('error')}, trying Node.js browser...")

    # 2. TERTIARY: Node.js Puppeteer non-headless
    browser_res = await solve_captcha_browser_python()
    if browser_res.get("success"):
        log.info("Captcha solved via Node.js Puppeteer (priority 2)")
        return browser_res
    log.warning(f"Node.js browser failed: {browser_res.get('error')}, trying 2Captcha API...")

    # 3. LAST RESORT: 2Captcha API (low score, but available)
    if api_key:
        result = await _solve_via_2captcha_api(api_key, proxy)
        if result.get("success"):
            log.info("Captcha solved via 2Captcha API (fallback)")
            return result
        log.warning(f"2Captcha API also failed: {result.get('error')}")

    return {"success": False, "error": "All captcha methods failed (Chrome CDP -> Camoufox -> Puppeteer -> 2Captcha)"}



async def _solve_via_2captcha_api(api_key: str, proxy: str | None = None) -> dict:
    """Internal: solve via 2Captcha/Rucaptcha HTTP API."""

    proxy_params = {}
    if proxy:
        # proxy format: login:pass@host:port or host:port
        parts = proxy.rsplit("@", 1)
        if len(parts) == 2:
            proxy_params = {
                "proxy": proxy,
                "proxytype": "HTTP",
            }

    async with aiohttp.ClientSession() as session:
        # Step 1: Submit task to /in.php
        submit_params = {
            "key": api_key,
            "method": "userrecaptcha",
            "version": "v3",
            "enterprise": "1",
            "googlekey": SITE_KEY,
            "pageurl": "https://www.ubisoft.com/en-us/help/account-recovery",
            "action": "AccountRecovery",
            "min_score": "0.9",
            "json": "1",
            **proxy_params,
        }
        try:
            resp = await session.get(TWOCAP_IN, params=submit_params, timeout=aiohttp.ClientTimeout(total=30))
            data = await resp.json(content_type=None)
        except Exception as e:
            return {"success": False, "error": f"Submit failed: {e}"}

        if data.get("status") != 1:
            err = data.get("request", str(data))
            log.warning(f"2Captcha submit error: {err}")
            return {"success": False, "error": err}

        task_id = data["request"]
        log.info(f"2Captcha task submitted: {task_id}")

        # Step 2: Wait initial 15s then poll every 5s (max 120s total)
        await asyncio.sleep(15)
        for attempt in range(21):  # 15 + 21*5 = 120s max
            await asyncio.sleep(5)
            try:
                resp = await session.get(TWOCAP_RES, params={
                    "key": api_key,
                    "action": "get",
                    "id": task_id,
                    "json": "1",
                }, timeout=aiohttp.ClientTimeout(total=15))
                result = await resp.json(content_type=None)
            except Exception as e:
                log.warning(f"2Captcha poll error: {e}")
                continue

            status = result.get("status")
            request_val = result.get("request", "")

            if status == 1 and request_val and request_val != "CAPCHA_NOT_READY":
                log.info(f"2Captcha solved! Token length: {len(request_val)}")
                return {"success": True, "token": request_val}

            if request_val not in ("CAPCHA_NOT_READY", ""):
                # Error code returned
                log.warning(f"2Captcha error: {request_val}")
                return {"success": False, "error": request_val}

        return {"success": False, "error": "Timeout: captcha not solved in 120s"}


# Keep backward-compatible alias so any code still calling solve_captcha_capsolver works
solve_captcha_capsolver = solve_captcha_2captcha


async def get_captcha_balance(api_key: str) -> dict:
    """Get 2Captcha account balance."""
    if not api_key:
        return {"success": False, "error": "No API key"}
    async with aiohttp.ClientSession() as session:
        try:
            resp = await session.get(TWOCAP_RES, params={
                "key": api_key,
                "action": "getbalance",
                "json": "1",
            }, timeout=aiohttp.ClientTimeout(total=15))
            data = await resp.json(content_type=None)
            if data.get("status") == 1:
                return {"success": True, "balance": float(data.get("request", 0))}
            return {"success": False, "error": data.get("request", str(data))}
        except Exception as e:
            return {"success": False, "error": str(e)}


# -- Akin Feedback -------------------------------------------------------------

AKIN_FEEDBACK_URL = "https://help.akin.ubisoft.com/api/v1/feedback/ticket"

async def send_feedback(ticket_id: str, session_uuid: str) -> dict:
    """POST to help.akin.ubisoft.com/api/v1/feedback/ticket.
    Sends a feedback ping after ticket creation (optional, improves ticket processing).
    Ported from ticket-manager-py/ubisoft_api.py."""
    payload = {
        "sessionId": session_uuid,
        "ticket": ticket_id,
        "form": "AccountRecovery",
    }
    hdrs = {
        "User-Agent": BASE_HEADERS["User-Agent"],
        "Accept": "*/*",
        "Content-Type": "application/json; charset=utf-8",
        "Origin": "https://www.ubisoft.com",
        "Referer": "https://www.ubisoft.com/",
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(AKIN_FEEDBACK_URL, headers=hdrs, json=payload,
                                    timeout=aiohttp.ClientTimeout(total=15)) as resp:
                data = await resp.json(content_type=None)
                return {"success": resp.status in (200, 201), "data": data}
    except Exception as e:
        log.warning(f"Akin feedback error (non-fatal): {e}")
        return {"success": False, "error": str(e)}
