"""
xbox_auth.py - Wrapper for Microsoft/Xbox/Ubisoft OAuth Flow
"""
import asyncio
import logging
from typing import Optional

from .xbox_linker.ms_auth import MicrosoftAuth
from .xbox_linker.xbox_profile import XboxProfile
from .xbox_linker.ubisoft_exchange import UbisoftExchange
from .xbox_linker.backup_email import BackupEmailManager

log = logging.getLogger("xbox_auth")

IMAP_TIMEOUT = 15  # Max seconds to wait on IMAP before giving up


def run_xbox_oauth_sync(
    email: str,
    password: str,
    imap_email: str,
    imap_password: str,
    proxy: Optional[str] = None,
) -> Optional[dict]:
    """
    Synchronous full Microsoft -> Xbox -> Ubisoft OAuth flow.
    Returns Ubisoft token dict or None.
    All exceptions are caught - None causes ticket_pipeline to fall back to Capsolver.
    """
    try:
        ms = MicrosoftAuth(proxy=proxy)

        # -- 1. Init OAuth ----------------------------------------------------
        if not ms.start_oauth():
            log.error(f"[xbox_auth] start_oauth failed for {email}")
            return None

        # -- 2. MS Login ------------------------------------------------------
        try:
            login_result = ms.login(email, password)
        except Exception as e:
            log.error(f"[xbox_auth] login exception for {email}: {e}")
            return None

        status = login_result.get("status", "error")

        # -- 3. Handle 2FA / proofs (max 3 rounds) ---------------------------
        for _ in range(3):
            if status == "need_proofs":
                try:
                    backup = BackupEmailManager(ms.session, proxy)
                    res = backup.add_backup_email(
                        html_page=login_result["html"],
                        url_page=login_result["url"],
                        backup_email=imap_email,
                        imap_email=imap_email,
                        imap_password=imap_password,
                    )
                    login_result = res
                    status = res.get("status", "error")
                except Exception as e:
                    log.warning(f"[xbox_auth] backup_email failed for {email}: {e}")
                    return None
                if status in ("got_code", "need_consent", "error"):
                    break
                continue

            elif status == "need_verify_existing":
                log.info(f"[xbox_auth] 2FA required for {email}, IMAP timeout={IMAP_TIMEOUT}s")
                try:
                    # Pass timeout kwarg - imap_helper respects it; if not supported it'll
                    # raise TypeError which we also catch as a safe fallback.
                    res = ms.verify_identity_confirm(
                        confirm_html=login_result["html"],
                        confirm_url=login_result["url"],
                        backup_email=imap_email,
                        imap_email=imap_email,
                        imap_password=imap_password,
                        imap_host=None,
                    )
                    login_result = res
                    status = res.get("status", "error")
                except (TimeoutError, OSError, ConnectionRefusedError) as e:
                    log.warning(f"[xbox_auth] IMAP timeout/refused for {email}: {e} - falling back")
                    return None
                except Exception as e:
                    log.warning(f"[xbox_auth] 2FA error for {email}: {type(e).__name__}: {e} - falling back")
                    return None
                if status in ("got_code", "need_consent", "error"):
                    break
                continue
            else:
                break

        # -- 4. Consent -------------------------------------------------------
        if status == "need_consent":
            try:
                code = ms.submit_consent(
                    canary=login_result["canary"],
                    consent_url=login_result.get("url"),
                    consent_html=login_result.get("html"),
                )
                if code:
                    status = "got_code"
            except Exception as e:
                log.warning(f"[xbox_auth] consent failed for {email}: {e}")
                return None

        if status != "got_code":
            log.warning(f"[xbox_auth] incomplete login for {email}, status={status}")
            return None

        # -- 5. Xbox Profile ------------------------------------------------------
        try:
            access_token = ms.get_xbox_access_token()
            if access_token:
                xbox = XboxProfile(ms.session)  # eng_final version: no proxy/email args
                x_token = xbox.get_xbox_token(access_token)
                if x_token:
                    xbox.create_profile()
        except Exception as e:
            log.warning(f"[xbox_auth] Xbox profile step failed (non-fatal) for {email}: {e}")

        # -- 6. Ubisoft Exchange ----------------------------------------------
        try:
            ubi = UbisoftExchange(ms.session)

            # Use the code we already have from the login flow
            fresh_code = login_result.get("code")

            if not fresh_code:
                # Request fresh authorization code (session cookies already set)
                from urllib.parse import urlparse, parse_qs
                r = ms.session.get(ms.auth_url, headers=ms.session.headers, allow_redirects=True)
                if "code=" in r.url:
                    fresh_code = parse_qs(urlparse(r.url).query).get("code", [None])[0]

            if not fresh_code:
                # Try via consent / post-login resolution
                resolved = ms._resolve_post_login(r)
                if resolved.get("status") == "got_code":
                    fresh_code = resolved["code"]
                elif resolved.get("status") == "need_consent":
                    fresh_code = ms.submit_consent(
                        canary=resolved["canary"],
                        consent_url=resolved.get("url"),
                        consent_html=resolved.get("html"),
                    )

            if not fresh_code:
                log.error(f"[xbox_auth] No Ubisoft code obtained for {email}")
                return None

            result = ubi.exchange_code(fresh_code)
            log.info(f"[xbox_auth] ✓ Xbox OAuth complete for {email}")
            return result

        except Exception as e:
            log.error(f"[xbox_auth] Ubisoft exchange error for {email}: {e}")
            return None

    except Exception as e:
        log.error(f"[xbox_auth] Unhandled error for {email}: {type(e).__name__}: {e}")
        return None


async def get_ubisoft_token_via_xbox(
    email: str,
    password: str,
    imap_email: str,
    imap_password: str,
    proxy: Optional[str] = None
) -> Optional[dict]:
    """Async wrapper - always returns dict or None, never raises."""
    try:
        return await asyncio.to_thread(
            run_xbox_oauth_sync,
            email, password, imap_email, imap_password, proxy
        )
    except Exception as e:
        log.error(f"[xbox_auth] to_thread error for {email}: {e}")
        return None
