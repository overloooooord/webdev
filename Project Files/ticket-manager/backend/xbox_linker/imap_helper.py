
import imaplib
import email
import re
import time
import json
import urllib.request
from email.header import decode_header

from .config import IMAP_HOSTS


def get_imap_config(email_addr: str) -> tuple:
    domain = email_addr.split("@")[1] if "@" in email_addr else ""
    if domain in IMAP_HOSTS:
        return IMAP_HOSTS[domain]
    return (f"mail.{domain}", 143, False)


# --- addy.to / anonaddy.com HTTP API reader -----------------------------------

ADDY_DOMAINS = {"addy.to", "anonaddy.com", "anonaddy.me"}

_ADDY_API_KEYS = {
    # Populated at runtime from DB settings key "addy_api_key"
}


def _get_addy_api_key() -> str:
    """Read addy.to API key from DB settings at runtime."""
    try:
        import sys, os
        # Find and import backend database without circular issues
        for mod_name in list(sys.modules.keys()):
            if "backend.database" in mod_name or mod_name == "backend.database":
                mod = sys.modules[mod_name]
                if hasattr(mod, "get_setting"):
                    return mod.get_setting("addy_api_key") or ""
    except Exception:
        pass
    return ""


class AddyIOReader:
    """Read Microsoft verification codes from addy.to via their REST API or mailbox alias."""

    def __init__(self, alias_email: str, api_key: str = None):
        self.alias_email = alias_email
        self.alias_local = alias_email.split("@")[0]
        domain = alias_email.split("@")[1] if "@" in alias_email else "addy.to"
        self.base_domain = domain
        self.api_key = api_key or _get_addy_api_key() or _ADDY_API_KEYS.get(domain, "")
        # addy.to API base
        if "anonaddy" in domain or "addy.to" in domain:
            self.api_base = "https://app.addy.io/api/v1"
        else:
            self.api_base = f"https://{domain}/api/v1"

    def get_verification_code(self, max_wait: int = 120, poll_interval: int = 8) -> str | None:
        """Poll addy.to API for a Microsoft verification code email."""
        if not self.api_key:
            print(f"[addy] No API key for {self.base_domain}, cannot read emails")
            return None

        start = time.time()
        print(f"[addy] Polling {self.base_domain} for verification code (up to {max_wait}s)...")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
        }

        while time.time() - start < max_wait:
            try:
                req = urllib.request.Request(
                    f"{self.api_base}/emails?filter[alias]={self.alias_local}",
                    headers=headers
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                    emails = data.get("data", [])

                    for em in reversed(emails):
                        subject = em.get("subject", "")
                        body_text = em.get("text", "") or em.get("html", "") or ""
                        from_email = em.get("from_email", "")

                        if "microsoft" not in from_email.lower() and "microsoft" not in body_text.lower():
                            continue

                        code = _extract_code_from_text(f"{subject} {body_text}")
                        if code:
                            print(f"[addy] ✓ Code found: {code} (subject: {subject})")
                            return code
            except Exception as e:
                print(f"[addy] API error: {e}")

            elapsed = int(time.time() - start)
            print(f"[addy] Waiting... ({elapsed}s / {max_wait}s)")
            time.sleep(poll_interval)

        print("[addy] Timeout - no code received")
        return None


def _extract_code_from_text(text: str) -> str | None:
    """Extract Microsoft OTT/verification code from email text.
    MS codes are typically 7 digits. Avoids matching years (2020-2030).
    """
    # Strip HTML tags for cleaner matching
    clean = re.sub(r'<[^>]+>', ' ', text)

    patterns = [
        # Most specific: explicit "code is NNNNNNN" or "code: NNNNNNN"
        r'(?:security\s*code|verification\s*code|single.?use\s*code|access\s*code)[:\s]+(\d{6,8})',
        r'(\d{6,8})\s*(?:is your|is the)\s*(?:security|verification|single.?use|microsoft)',
        # Microsoft-specific: "Your code is" / "Use this code" / "Use NNNNNNN as"
        r'(?:your\s*code\s*is|use\s*this\s*code)[:\s]+(\d{6,8})',
        r'use\s+(\d{6,8})\s+as\s+(?:the|your)?\s*microsoft',
        # HTML table cell or bold tag - MS puts the code in a <td> or <b>/<strong> alone
        r'<(?:td|b|strong|span)[^>]*>\s*(\d{6,8})\s*</(?:td|b|strong|span)>',
        # Specific fallback: "code" followed by digits within 20 chars
        r'\bcode\b.{1,20}?(\d{6,8})',
    ]

    for pattern in patterns:
        m = re.search(pattern, clean, re.IGNORECASE | re.DOTALL)
        if m:
            code = m.group(1)
            # Extra safety: skip obvious years
            if len(code) == 4 and 2000 <= int(code) <= 2099:
                continue
            return code
    return None


# --- Main IMAPCodeReader class ------------------------------------------------

class IMAPCodeReader:

    def __init__(self, imap_email: str, imap_password: str,
                 imap_host: str = None, imap_port: int = None):
        self.email_addr = imap_email
        self.password = imap_password
        domain = imap_email.split("@")[1] if "@" in imap_email else ""
        self._is_addy = domain in ADDY_DOMAINS or "addy" in domain or "4wrd" in domain

        if self._is_addy:
            # Use addy.to API instead of IMAP
            self._addy = AddyIOReader(imap_email, api_key=self.password)
        else:
            auto_host, auto_port, self.use_ssl = get_imap_config(imap_email)
            self.host = imap_host or auto_host
            self.port = imap_port or auto_port
            self.connection = None

    def connect(self):
        if self._is_addy:
            # No connection needed for API-based reader
            return
        print(f"[imap] Connecting to {self.host}:{self.port} (SSL={self.use_ssl})...")
        if self.use_ssl:
            self.connection = imaplib.IMAP4_SSL(self.host, self.port)
        else:
            self.connection = imaplib.IMAP4(self.host, self.port)
        self.connection.login(self.email_addr, self.password)
        print(f"[imap] Logged in as {self.email_addr}")

    def get_verification_code(self, sender_filter: str = "microsoft",
                              max_wait: int = 120, poll_interval: int = 5) -> str | None:
        if self._is_addy:
            return self._addy.get_verification_code(max_wait=max_wait)

        if not self.connection:
            self.connect()

        print(f"[imap] Waiting for verification code (up to {max_wait}s)...")
        start_time = time.time()

        while time.time() - start_time < max_wait:
            try:
                self.connection.select("INBOX")
                status, messages = self.connection.search(None, "UNSEEN")
                if status != "OK" or not messages[0]:
                    # Fallback to ALL if UNSEEN returns empty
                    status, messages = self.connection.search(None, "ALL")

                if status != "OK" or not messages[0]:
                    time.sleep(poll_interval)
                    continue

                msg_ids = messages[0].split()[-10:]  # Inspect last 10 emails
                for msg_id in reversed(msg_ids):
                    status, msg_data = self.connection.fetch(msg_id, "(RFC822)")
                    if status != "OK":
                        continue

                    msg = email.message_from_bytes(msg_data[0][1])
                    from_header = str(msg.get("From", "")).lower()
                    subject = self._decode_header(msg.get("Subject", ""))

                    # Parse email Date header to ensure email arrived after start_time
                    date_header = msg.get("Date")
                    if date_header:
                        try:
                            from email.utils import parsedate_to_datetime
                            msg_dt = parsedate_to_datetime(date_header)
                            # Convert to unix timestamp (UTC)
                            msg_ts = msg_dt.timestamp()
                            if msg_ts < (start_time - 30):
                                # Old email from a previous attempt - skip
                                continue
                        except Exception:
                            pass

                    # Filter out non-code alert/notification subjects
                    subj_lower = subject.lower()
                    if "unusual sign-in" in subj_lower or "security alert" in subj_lower or "unusual activity" in subj_lower:
                        continue

                    print(f"[imap] Found fresh email ({date_header}): {subject}")
                    body = self._get_body(msg)
                    code = _extract_code_from_text(f"{subject} {body}")
                    if code:
                        print(f"[imap] Code found: {code}")
                        return code

            except Exception as e:
                print(f"[imap] Error: {e}")

            elapsed = int(time.time() - start_time)
            print(f"[imap] Waiting... ({elapsed}s / {max_wait}s)")
            time.sleep(poll_interval)

        print("[imap] Timeout - no code received")
        return None

    def _get_body(self, msg) -> str:
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                ct = part.get_content_type()
                if ct in ("text/plain", "text/html"):
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        body += payload.decode(charset, errors="replace")
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                body = payload.decode(charset, errors="replace")
        return body

    def _decode_header(self, header_val) -> str:
        if not header_val:
            return ""
        parts = decode_header(header_val)
        decoded = []
        for data, charset in parts:
            if isinstance(data, bytes):
                decoded.append(data.decode(charset or "utf-8", errors="replace"))
            else:
                decoded.append(data)
        return " ".join(decoded)

    def close(self):
        if self._is_addy:
            return
        if self.connection:
            try:
                self.connection.logout()
            except Exception:
                pass
