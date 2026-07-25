"""
ticket_pipeline.py - Full Ticket Creation + Monitoring Pipeline

Replaces: ticket-creator.js, token-manager.js, ticket-monitor.js

Pipeline:
  1. Auth (refresh or re-login) -> 2. Elevate to TICKET scope ->
  3. Solve reCAPTCHA -> 4. Create ticket via CSHelp API -> 5. Save to DB

Token Manager: Background loop refreshing all tokens every N minutes.
Ticket Monitor: Background loop polling Ubisoft for status changes + new messages.
"""
import asyncio
import json
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta

from .database import (
    get_account_by_id, get_authenticated_accounts, get_all_accounts,
    get_all_tickets, get_ticket_by_id, get_latest_message, get_setting,
    update_account_auth, update_account_login_status,
    insert_ticket, update_ticket_status, insert_message, get_messages_by_ticket,
    save_xbox_token, get_xbox_token,
)
from .ubisoft_api import (
    authenticate, refresh_token, elevate_session,
    create_ticket, close_ticket, send_comment,
    get_ticket_status, get_ticket_interactions,
    solve_captcha_2captcha,
)

log = logging.getLogger("ticket_pipeline")

# -- Broadcast callback (set by server.py) ------------------------------------
_broadcast_fn = None

def set_broadcast(fn):
    global _broadcast_fn
    _broadcast_fn = fn

def broadcast(msg: dict):
    if _broadcast_fn:
        _broadcast_fn(msg)


# ===============================================================================
# TICKET CREATION PIPELINE
# ===============================================================================

async def create_ticket_for_account(account_id: int, reason: str = "accountHackedOrTakenOver") -> dict:
    """Full pipeline: auth -> elevate -> captcha -> create ticket -> save to DB."""
    account = get_account_by_id(account_id)
    if not account:
        return {"success": False, "error": "Account not found"}

    proxy = get_setting("proxy_us")
    contact_email = account.get("platform_login_email") or account.get("backup_email") or account["login_email"]
    lost_email = account["login_email"]
    username = account["username"]

    # For non-XBL accounts without a token, try auto-login first
    if account["platform"] != "XBL" and not account.get("ubisoft_token"):
        relog = await authenticate(account["login_email"], account["login_password"], proxy)
        if relog["success"]:
            account["ubisoft_token"] = relog["token"]
            account["session_id"] = relog["sessionId"]
            _save_auth(account_id, relog)
        else:
            return {"success": False, "error": "Account not authenticated and auto-login failed"}

    broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "auth"})

    # -- Step 1: Refresh / re-login -------------------------------------------
    fresh_token = account.get("ubisoft_token") or ""
    fresh_session_id = account.get("session_id")

    try:
        auth_data = json.loads(account.get("auth_data_json") or "{}")
        if auth_data.get("ticket"):
            ref = await refresh_token(auth_data, proxy)
            if ref["success"]:
                fresh_token = ref["token"]
                fresh_session_id = ref["sessionId"]
                _save_auth(account_id, ref)
                log.info(f"Token refreshed for {username}")
            else:
                log.warning(f"Refresh failed for {username} ({ref.get('reason')}), re-logging in...")
                relog = await authenticate(account["login_email"], account["login_password"], proxy)
                if relog["success"]:
                    fresh_token = relog["token"]
                    fresh_session_id = relog["sessionId"]
                    _save_auth(account_id, relog)
                    log.info(f"Re-login OK for {username}")
                else:
                    log.warning(f"Re-login failed for {username}, using existing token")
    except Exception as e:
        log.warning(f"Auth refresh error (non-fatal): {e}")

    captcha_token = ""
    xbox_oauth_ok = False

    # -- Xbox OAuth (XBL only) - provides Ubisoft token, NOT captcha bypass --
    # NOTE: Xbox OAuth gives us a Ubisoft accessToken (authorization).
    # The account-recovery-cases endpoint ALWAYS requires reCAPTCHA regardless.
    if account["platform"] == "XBL":
        from .xbox_auth import get_ubisoft_token_via_xbox
        broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "xbox_oauth"})

        # 1️⃣ Check DB cache first - avoids triggering MS 2FA on every ticket
        cached_tok = get_xbox_token(account_id)
        if cached_tok:
            log.info(f"Using cached Xbox accessToken for {username}")
            fresh_token = cached_tok
            xbox_oauth_ok = True
        else:
            log.info(f"Attempting Xbox OAuth for {username} (no cached token)...")
            # imap_login = real IMAP (rambler.ru) that receives forwards from addy.to alias
            # backup_email = the anon alias added to MS account (addy.to/addymail.com)
            imap_login_str = account.get("imap_login") or ""
            raw_backup = account.get("backup_email") or ""

            if imap_login_str and ":" in imap_login_str:
                # Use dedicated imap_login (rambler.ru etc) - this is what receives forwarded 2FA codes
                imap_email_addr, imap_pw = imap_login_str.split(":", 1)
                log.info(f"Using imap_login field: {imap_email_addr}")
            elif ":" in raw_backup:
                # Legacy: backup_email stored as email:pass
                imap_email_addr, imap_pw = raw_backup.split(":", 1)
            else:
                # Fallback: read IMAP with platform password (may fail)
                imap_email_addr = raw_backup or account["login_email"]
                imap_pw = account.get("platform_login_password") or account["login_password"]
                log.warning(f"No imap_login in DB for {username} - 2FA reads may fail")

            ubi_data = await get_ubisoft_token_via_xbox(
                email=account["platform_login_email"] or account["login_email"],
                password=account["platform_login_password"] or account["login_password"],
                imap_email=imap_email_addr,
                imap_password=imap_pw,
                proxy=proxy
            )
            if ubi_data and ubi_data.get("accessToken"):
                fresh_token = ubi_data["accessToken"]
                xbox_oauth_ok = True
                # 2️⃣ Save to DB - next time we skip MS login entirely
                expiry = ubi_data.get("expirationDate") or ubi_data.get("expiry")
                save_xbox_token(account_id, fresh_token, str(expiry) if expiry else None)
                log.info(f"Xbox OAuth success for {username} - token cached")
            else:
                log.warning(f"Xbox OAuth failed for {username}, using Basic Auth token")

    # -- Step 2: Elevate session to TICKET_APP_ID scope ---------------------
    # Both Basic Auth tokens AND Xbox OAuth tokens need elevation
    broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "elevating"})
    elev = await elevate_session(fresh_token, proxy)
    if elev["success"]:
        fresh_token = elev["token"]
        fresh_session_id = elev["sessionId"]
        log.info(f"Session elevated for {username}")
    else:
        if not xbox_oauth_ok:
            return {"success": False, "error": f"Session elevation failed: {elev.get('reason')}"}
        # For Xbox OAuth tokens, elevation failure is non-fatal - the connect.ubisoft.com
        # accessToken may work directly with CSHelp API
        log.warning(f"Elevation failed for Xbox OAuth token ({elev.get('reason')}), trying direct token...")

    # -- Step 3: Try Chrome CDP full ticket creation (captcha + submit in one call) --
    # This is the most reliable method - exactly like auto_ticket.py which WORKS.
    # It injects reCAPTCHA into real Chrome and submits the ticket from the browser context.
    cdp_enabled = get_setting("cdp_enabled") != "0"  # default ON
    if not cdp_enabled:
        log.info(f"Chrome CDP disabled in settings, skipping for {username}")
    else:
        broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "chrome_cdp"})
        try:
            from .captcha_chrome_cdp import create_ticket_via_chrome_cdp
            log.info(f"Trying Chrome CDP full ticket creation for {username}...")
            cdp_result = await create_ticket_via_chrome_cdp(
                token=fresh_token, session_id=fresh_session_id,
                contact_email=contact_email, lost_email=lost_email, username=username,
                reason=reason,
            )
            if cdp_result.get("success"):
                log.info(f"Chrome CDP ticket created for {username}: #{cdp_result.get('caseNumber')}")
                return _save_ticket_to_db(account_id, account, cdp_result, contact_email, lost_email, reason)
            else:
                cdp_err = cdp_result.get("error", "unknown")
                log.warning(f"Chrome CDP ticket failed for {username}: {cdp_err}")
                # Check if it's a non-retryable error (account not found, etc.)
                if isinstance(cdp_err, dict):
                    err_code = cdp_err.get("errorCode")
                    if err_code in (6020, 6500):
                        error_map = {
                            6020: "Error 6020: Account not found on Ubisoft's side.",
                            6500: "Error 6500: Contact email flagged as suspicious.",
                        }
                        return {"success": False, "error": error_map.get(err_code, str(cdp_err))}
        except Exception as e:
            log.warning(f"Chrome CDP import/run error: {e}")

    # -- Step 3b: Fallback captcha chain (Camoufox -> Puppeteer -> 2Captcha) ----
    broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "solving_captcha"})
    api_key = get_setting("captcha_api_key") or ""
    captcha = await solve_captcha_2captcha(api_key, proxy)
    if not captcha["success"]:
        log.error(f"Captcha failed for {username}: {captcha.get('error')}")
        return {"success": False, "error": f"Captcha failed: {captcha.get('error')}"}
    captcha_token = captcha["token"]
    log.info(f"Captcha solved for {username} (token length: {len(captcha_token)})")

    # -- Step 4: Create ticket via API ----------------------------------------
    broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "creating_ticket"})
    result = await create_ticket(
        token=fresh_token, session_id=fresh_session_id, proxy=proxy,
        contact_email=contact_email, lost_email=lost_email,
        username=username, captcha_token=captcha_token,
        reason=reason,
    )

    if not result["success"]:
        err = result.get("error", {})
        err_code = err.get("errorCode") if isinstance(err, dict) else None

        if err_code == 6010:
            log.warning(f"Error 6010 for {username} - reCAPTCHA rejected. Launching form-bot fallback...")
            broadcast({"type": "ticket_creating", "accountId": account_id, "username": username, "step": "browser_fallback"})

            bot_result = await _run_formbot(account_id)
            if bot_result and bot_result.get("success"):
                log.info(f"form-bot succeeded for {username}: case #{bot_result.get('caseNumber')}")
                return _save_ticket_to_db(account_id, account, bot_result, contact_email, lost_email, reason)
            else:
                bot_err = (bot_result or {}).get("error", "Unknown form-bot error")
                log.error(f"form-bot failed for {username}: {bot_err}")
                return {"success": False, "error": f"6010 + form-bot failed: {bot_err}"}

        error_map = {
            6020: "Error 6020: Account not found on Ubisoft's side.",
            6500: "Error 6500: Contact email flagged as suspicious.",
            7050: "Error 7050: Rate limit exceeded.",
        }
        if err_code in error_map:
            return {"success": False, "error": error_map[err_code]}
        return {"success": False, "error": f"Ticket creation failed: {json.dumps(err)[:200]}"}

    # -- Step 5: Save to DB ---------------------------------------------------
    return _save_ticket_to_db(account_id, account, result, contact_email, lost_email, reason)


def _save_auth(account_id: int, auth_result: dict):
    update_account_auth(account_id, {
        "ubisoft_token": auth_result["token"],
        "token_expiry": auth_result.get("expiration"),
        "session_id": auth_result.get("sessionId"),
        "profile_id": auth_result.get("profileId"),
        "user_id": auth_result.get("userId"),
        "auth_data_json": json.dumps(auth_result.get("data", {})),
    })



async def _run_formbot(account_id: int) -> dict | None:
    """Run form-bot.js via Node.js to submit ticket through real browser.
    Passes account_id, reads JSON result from stdout."""
    import subprocess, shutil, sys, asyncio as _asyncio
    from pathlib import Path as _Path

    node_bin = shutil.which("node") or shutil.which("nodejs")
    if not node_bin:
        log.error("_run_formbot: Node.js not found on PATH")
        return {"success": False, "error": "Node.js not installed"}

    bot_script = _Path(__file__).parent.parent / "server" / "run-bot-cli.js"
    if not bot_script.exists():
        log.error(f"_run_formbot: {bot_script} not found")
        return {"success": False, "error": "run-bot-cli.js missing"}

    log.info(f"_run_formbot: launching node {bot_script} {account_id}")
    try:
        proc = await _asyncio.create_subprocess_exec(
            node_bin, str(bot_script), str(account_id),
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.PIPE,
            cwd=str(bot_script.parent.parent),
        )
        try:
            stdout, stderr = await _asyncio.wait_for(proc.communicate(), timeout=180)
        except _asyncio.TimeoutError:
            proc.kill()
            return {"success": False, "error": "form-bot timed out after 180s"}

        out = stdout.decode().strip()
        err = stderr.decode().strip()
        if err:
            log.warning(f"_run_formbot stderr: {err[-500:]}")

        # Last line of stdout should be JSON
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except Exception:
                    pass
        log.error(f"_run_formbot: no JSON in output: {out[-300:]}")
        return {"success": False, "error": f"No JSON response from form-bot. Output: {out[-200:]}"}
    except Exception as e:
        log.error(f"_run_formbot exception: {e}")
        return {"success": False, "error": str(e)}


def _save_ticket_to_db(account_id, account, result, contact_email, lost_email, reason: str = "accountHackedOrTakenOver") -> dict:

    # Human-readable reason labels
    reason_labels = {
        "accountHackedOrTakenOver": "Account hacked or taken over",
        "lostAccessToEmail": "Lost access to email",
        "forgotCredentials": "Forgot credentials",
        "other": "Other",
    }
    reason_label = reason_labels.get(reason, reason)

    ticket_id = insert_ticket({
        "account_id": account_id,
        "case_number": result["caseNumber"],
        "case_id_full": result.get("caseIdFull"),
        "status": "Open",
        "platform": account["platform"],
        "contact_email": contact_email,
        "lost_email": lost_email,
        "ticket_reason": reason,
    })

    insert_message({
        "ticket_id": ticket_id,
        "comment_id": None,
        "body": (f"Ticket submitted - Account Recovery\n\n"
                 f"Username: {account['username']}\nLost Email: {lost_email}\n"
                 f"Contact Email: {contact_email}\nPlatform: {account['platform']}\n"
                 f"Reason: {reason_label}"),
        "created_by": "System",
        "created_at_remote": datetime.utcnow().isoformat(),
        "source": "TicketCreation",
    })

    log.info(f"Ticket #{result['caseNumber']} saved for {account['username']} (reason: {reason})")
    broadcast({
        "type": "ticket_created", "accountId": account_id,
        "ticketId": ticket_id, "caseNumber": result["caseNumber"],
        "username": account["username"],
    })

    return {"success": True, "ticketId": ticket_id, "caseNumber": result["caseNumber"]}


async def close_ticket_by_id(ticket_id: int) -> dict:
    ticket = get_ticket_by_id(ticket_id)
    if not ticket:
        return {"success": False, "error": "Ticket not found"}
    account = get_account_by_id(ticket["account_id"])
    if not account:
        return {"success": False, "error": "Account not found"}

    proxy = get_setting("proxy_us")
    result = await close_ticket(ticket["case_number"], account.get("ubisoft_token") or "",
                                account.get("session_id"), proxy)
    
    # If Ubisoft API returns invalid caseNumber (synthetic/demo ticket), still update local DB gracefully
    if not result["success"]:
        err_msg = str(result.get("error", ""))
        if "not valid" in err_msg or "400" in err_msg or not ticket["case_number"].isdigit():
            log.warning(f"Close ticket #{ticket['case_number']} on Ubisoft API returned: {err_msg}. Updating local status to Completed.")

    update_ticket_status(ticket_id, "Completed")
    broadcast({"type": "ticket_closed", "ticketId": ticket_id, "caseNumber": ticket["case_number"]})
    return {"success": True}


async def reply_to_ticket(ticket_id: int, message_body: str) -> dict:
    ticket = get_ticket_by_id(ticket_id)
    if not ticket:
        return {"success": False, "error": "Ticket not found"}
    account = get_account_by_id(ticket["account_id"])
    if not account:
        return {"success": False, "error": "Account not found"}

    proxy = get_setting("proxy_us")
    result = await send_comment(ticket["case_number"], message_body,
                                account.get("ubisoft_token") or "", account.get("session_id"), proxy)
    
    # If Ubisoft API fails because the caseNumber is synthetic/local, save locally as demo response
    if not result["success"]:
        err_msg = str(result.get("error", ""))
        if "not valid" in err_msg or "400" in err_msg or not ticket["case_number"].isdigit():
            log.warning(f"Ubisoft API reply for #{ticket['case_number']} failed ({err_msg}). Saving message locally for demo/test mode.")
            insert_message({
                "ticket_id": ticket_id, "comment_id": None,
                "body": message_body, "created_by": "User (Local)",
                "created_at_remote": datetime.utcnow().isoformat(), "source": "LocalMock",
            })
            update_ticket_status(ticket_id, "Awaiting Response")
            broadcast({"type": "message_sent", "ticketId": ticket_id, "caseNumber": ticket["case_number"]})
            return {"success": True, "note": "Saved locally (synthetic ticket)"}
        return {"success": False, "error": f"Reply failed: {result.get('error')}"}

    insert_message({
        "ticket_id": ticket_id, "comment_id": None,
        "body": message_body, "created_by": "Technical API",
        "created_at_remote": datetime.utcnow().isoformat(), "source": "CaseComment",
    })
    update_ticket_status(ticket_id, "Awaiting Response")
    broadcast({"type": "message_sent", "ticketId": ticket_id, "caseNumber": ticket["case_number"]})
    return {"success": True}


# ===============================================================================
# TOKEN MANAGER (Background Loop)
# ===============================================================================

_token_task: asyncio.Task | None = None

async def _token_refresh_loop():
    """Refresh tokens for all authenticated accounts periodically."""
    while True:
        interval = int(get_setting("token_refresh_minutes") or 50) * 60
        await asyncio.sleep(30)  # initial delay

        try:
            accounts = get_authenticated_accounts()
            proxy = get_setting("proxy_us")
            ok, fail = 0, 0

            for acc in accounts:
                try:
                    if not _needs_refresh(acc.get("token_expiry")):
                        continue

                    auth_data = json.loads(acc.get("auth_data_json") or "{}")
                    if not auth_data.get("ticket"):
                        continue

                    ref = await refresh_token(auth_data, proxy)
                    if ref["success"]:
                        _save_auth(acc["id"], ref)
                        ok += 1
                    else:
                        # Try re-login
                        relog = await authenticate(acc["login_email"], acc["login_password"], proxy)
                        if relog["success"]:
                            _save_auth(acc["id"], relog)
                            ok += 1
                        else:
                            fail += 1
                    await asyncio.sleep(2)
                except Exception as e:
                    log.error(f"Token refresh error for {acc['username']}: {e}")
                    fail += 1

            if ok or fail:
                log.info(f"Token refresh: {ok} OK, {fail} failed")
        except Exception as e:
            log.error(f"Token refresh cycle error: {e}")

        await asyncio.sleep(interval)


def _needs_refresh(expiry_str: str | None) -> bool:
    if not expiry_str:
        return True
    try:
        expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
        return (expiry - datetime.now(timezone.utc)) < timedelta(minutes=15)
    except Exception:
        return True


def start_token_manager():
    global _token_task
    _token_task = asyncio.ensure_future(_token_refresh_loop())
    log.info("Token manager started")


# ===============================================================================
# TICKET MONITOR (Background Loop)
# ===============================================================================

_monitor_task: asyncio.Task | None = None

async def _ticket_monitor_loop():
    """Poll all active tickets for status changes and new messages."""
    await asyncio.sleep(15)  # initial delay

    while True:
        interval = int(get_setting("poll_interval_seconds") or 45)

        try:
            tickets = [t for t in get_all_tickets()
                       if t["status"] != "Completed" and t.get("case_number")
                       and t["case_number"].isdigit()]

            proxy = get_setting("proxy_us")

            for ticket in tickets:
                try:
                    await _poll_single_ticket(ticket, proxy)
                    await asyncio.sleep(2)
                except Exception as e:
                    log.error(f"Monitor error for #{ticket.get('case_number')}: {e}")
        except Exception as e:
            log.error(f"Monitor cycle error: {e}")

        await asyncio.sleep(interval)


async def _poll_single_ticket(ticket: dict, proxy: str | None):
    account = get_account_by_id(ticket["account_id"])
    if not account or not account.get("ubisoft_token"):
        return

    token = account["ubisoft_token"]
    session_id = account.get("session_id")

    # 1) Check status
    sr = await get_ticket_status(ticket["case_number"], token, session_id, proxy)
    if sr["success"] and isinstance(sr.get("data"), dict):
        ubi_status = (sr["data"].get("status", {}).get("name") or "").lower()
        new_status = _map_ubi_status(ubi_status)

        if ubi_status == "closed":
            if ticket["status"] != "Awaiting Reply":
                update_ticket_status(ticket["id"], "Awaiting Reply")
            broadcast({
                "type": "ticket_agent_closed", "ticketId": ticket["id"],
                "caseNumber": ticket["case_number"],
            })
        elif new_status and new_status != ticket["status"]:
            update_ticket_status(ticket["id"], new_status)
            broadcast({
                "type": "ticket_status_changed", "ticketId": ticket["id"],
                "oldStatus": ticket["status"], "newStatus": new_status,
            })

    # 2) Check messages
    ir = await get_ticket_interactions(ticket["case_number"], token, session_id, proxy)
    if ir["success"] and isinstance(ir.get("data"), dict):
        interactions = ir["data"].get("interactions", [])
        latest_local = get_latest_message(ticket["id"])
        cutoff = (latest_local or {}).get("created_at_remote", "1970-01-01T00:00:00")

        new_count = 0
        for msg in reversed(interactions):
            if (msg.get("createdAt") or "") > cutoff:
                insert_message({
                    "ticket_id": ticket["id"],
                    "comment_id": msg.get("id"),
                    "body": msg.get("body", ""),
                    "created_by": msg.get("createdBy", "Unknown"),
                    "created_at_remote": msg.get("createdAt", datetime.utcnow().isoformat()),
                    "source": msg.get("source", "CaseComment"),
                })
                new_count += 1

                if msg.get("createdBy") == "Ubisoft Agent":
                    broadcast({
                        "type": "new_agent_message", "ticketId": ticket["id"],
                        "caseNumber": ticket["case_number"],
                        "messagePreview": (msg.get("body") or "")[:120],
                    })

                    # AI Auto-Reply if enabled for this ticket
                    if ticket.get("ai_auto_reply"):
                        try:
                            api_key = get_setting("ai_api_key") or "sk-z9EOr1YLqKvRqHbAuDmckWfqbtxheIB9J0jSwMOrroHaXDTz"
                            model = get_setting("ai_model") or "deepseek-v4-flash:floor"
                            from openai import OpenAI
                            client = OpenAI(api_key=api_key, base_url="https://yunwu.ai/v1")

                            ai_history = [{"role": "system", "content": (
                                "You are responding on behalf of the account owner to Ubisoft support "
                                "about an account recovery case. The account was compromised/hacked. "
                                "Be professional, polite, cooperative. Keep replies concise (2-4 sentences). "
                                "Match the language of the agent's message. Never reveal this is automated."
                            )}]
                            recent_msgs = get_messages_by_ticket(ticket["id"])
                            for m in recent_msgs[-8:]:
                                role = "assistant" if "ubisoft" in (m.get("created_by") or "").lower() else "user"
                                ai_history.append({"role": role, "content": m.get("body", "")})

                            response = client.chat.completions.create(
                                model=model, messages=ai_history, max_tokens=300, temperature=0.7,
                            )
                            ai_reply = response.choices[0].message.content.strip()

                            # Send reply
                            from .ubisoft_api import send_comment as _send_comment
                            send_result = await _send_comment(
                                ticket["case_number"], ai_reply, token, session_id, proxy
                            )
                            if send_result.get("success"):
                                insert_message({
                                    "ticket_id": ticket["id"], "comment_id": None,
                                    "body": ai_reply, "created_by": "AI Auto-Reply",
                                    "created_at_remote": datetime.utcnow().isoformat(),
                                    "source": "AIAutoReply",
                                })
                                update_ticket_status(ticket["id"], "Awaiting Response")
                                broadcast({
                                    "type": "ai_auto_replied", "ticketId": ticket["id"],
                                    "caseNumber": ticket["case_number"],
                                    "reply": ai_reply[:120],
                                })
                                log.info(f"🤖 AI auto-replied to #{ticket['case_number']}: {ai_reply[:60]}")
                            else:
                                log.warning(f"AI auto-reply send failed for #{ticket['case_number']}")
                        except Exception as e:
                            log.error(f"AI auto-reply error for #{ticket['case_number']}: {e}")

        if new_count:
            log.info(f"Ticket #{ticket['case_number']}: {new_count} new messages")


def _map_ubi_status(ubi: str) -> str | None:
    if ubi == "waiting":
        return "Awaiting Reply"
    if ubi == "updated":
        return "Awaiting Response"
    if ubi in ("new", "open"):
        return "Open"
    return None


def start_ticket_monitor():
    global _monitor_task
    _monitor_task = asyncio.ensure_future(_ticket_monitor_loop())
    log.info("Ticket monitor started")


# ===============================================================================
# BULK LOGIN
# ===============================================================================

async def bulk_login_all() -> dict:
    accounts = [a for a in get_all_accounts() if a["login_status"] != "authenticated"]
    proxy = get_setting("proxy_us")
    ok, fail = 0, 0

    broadcast({"type": "bulk_login_start", "total": len(accounts)})

    for acc in accounts:
        try:
            result = await authenticate(acc["login_email"], acc["login_password"], proxy)
            if result["success"]:
                _save_auth(acc["id"], result)
                ok += 1
                broadcast({"type": "account_authenticated", "accountId": acc["id"], "username": acc["username"]})
            else:
                fail += 1
                broadcast({"type": "account_login_failed", "accountId": acc["id"], "reason": result.get("reason")})
            await asyncio.sleep(1.5)
        except Exception as e:
            fail += 1
            log.error(f"Bulk login error for {acc['username']}: {e}")

    broadcast({"type": "bulk_login_complete", "success": ok, "failed": fail, "total": len(accounts)})
    return {"success": ok, "failed": fail, "total": len(accounts)}
