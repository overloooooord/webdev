
import re
import time
import json
from .config import BROWSER_HEADERS, IMAP_HOSTS


def _extract_hidden_fields(html: str) -> dict:
    """Extract all hidden input fields from HTML."""
    fields = {}
    for m in re.finditer(
        r'<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"',
        html, re.IGNORECASE,
    ):
        fields[m.group(1)] = m.group(2)
    # Also try value before name order
    for m in re.finditer(
        r'<input[^>]*value="([^"]*)"[^>]*name="([^"]*)"[^>]*type="hidden"',
        html, re.IGNORECASE,
    ):
        fields[m.group(2)] = m.group(1)
    return fields


def _extract_canary(html: str) -> str:
    """Extract canary/CSRF from HTML."""
    for pattern in [
        r'name="canary"\s*value="([^"]+)"',
        r'"canary"\s*:\s*"([^"]+)"',
        r"canary\s*=\s*'([^']+)'",
    ]:
        m = re.search(pattern, html, re.IGNORECASE)
        if m:
            return m.group(1)
    return ""


class BackupEmailManager:
    """Backup email management via Microsoft Account proofs/Add."""

    def __init__(self, session):
        """
        Args:
            session: requests.Session with authenticated cookies
        """
        self.session = session

    def add_backup_email(self, backup_email: str, proofs_url: str = None,
                         proofs_html: str = None) -> dict:
        """
        Attach backup email to Microsoft account.
        
        If proofs_url and proofs_html are provided, use them (from login flow).
        Otherwise open proofs/Add ourselves.
        """
        print(f"[backup] Attaching backup email: {backup_email}...")

        if proofs_html:
            html = proofs_html
            url = proofs_url or ""
        else:
            # Opening proofs/Add page
            url = proofs_url or "https://account.live.com/proofs/manage/additional"
            resp = self.session.get(url, headers={
                **BROWSER_HEADERS,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            }, allow_redirects=True)
            html = resp.text
            url = resp.url

        print(f"[backup] Proofs page URL: {url[:100]}...")

        # Extract hidden fields and canary
        hidden_fields = _extract_hidden_fields(html)
        canary = _extract_canary(html)

        # Look for email addition form
        # Microsoft proofs/Add has several UI variants
        
        # Variant 1: Direct form with EmailAddress
        form_action = None
        form_match = re.search(r'<form[^>]*action="([^"]*)"[^>]*method="post"', html, re.IGNORECASE)
        if form_match:
            form_action = form_match.group(1).replace("&amp;", "&")

        # Look for API endpoint for adding proof
        api_match = re.search(r'"(https?://[^"]*(?:AddProof|proofs/Add)[^"]*)"', html)
        add_url = api_match.group(1) if api_match else None

        # Determine where to send
        if not add_url and not form_action:
            # Try standard endpoint
            add_url = re.sub(r'\?.*', '', url)
            if not add_url.endswith('/'):
                add_url += '/'

        target_url = add_url or form_action or url
        print(f"[backup] Target URL: {target_url[:100]}...")

        # Submit email addition request
        data = {
            **hidden_fields,
            "iProofOptions": "Email",
            "EmailAddress": backup_email,
            "action": "AddProof",
        }
        if canary:
            data["canary"] = canary

        resp = self.session.post(
            target_url,
            data=data,
            headers={
                **BROWSER_HEADERS,
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://account.live.com",
                "Referer": url,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
            },
            allow_redirects=True,
        )

        print(f"[backup] Response: {resp.status_code}, URL: {resp.url[:100]}...")

        # Check if verification code is needed
        resp_text = resp.text.lower()
        if any(x in resp_text for x in ["verify", "code", "enter the code", "confirmation"]):
            verify_canary = _extract_canary(resp.text)
            verify_fields = _extract_hidden_fields(resp.text)
            print("[backup] -> Verification code needed")
            return {
                "status": "need_verification",
                "canary": verify_canary or canary,
                "verify_url": resp.url,
                "hidden_fields": verify_fields,
                "html": resp.text,
            }

        # Redirected to login - session expired
        if "login.live.com" in resp.url:
            print("[backup] ✗ Redirected to login - session expired")
            return {"status": "error", "message": "Session expired"}

        # Check for success
        if any(x in resp_text for x in ["success", "added", "security info"]):
            print("[backup] ✓ Backup email added!")
            return {"status": "success"}

        # Save for debugging
        print(f"[backup] Unknown response. HTML length: {len(resp.text)}")
        return {
            "status": "unknown",
            "url": resp.url,
            "html": resp.text,
        }

    def request_verification_code(self, verify_html: str, verify_url: str,
                                   backup_email: str) -> bool:
        """
        Explicitly requests OTT code delivery to backup email.
        Microsoft does not send it automatically - need to POST to
        proofs/Verify with selected method (Email) to trigger sending.
        """
        print(f"[backup] Requesting OTT code to {backup_email}...")

        # Method 1: JSON API SendOtt (new Microsoft pages)
        # Extract apiCanary from HTML
        m = re.search(r'"apiCanary"\s*:\s*"([^"]+)"', verify_html)
        api_canary = m.group(1).encode().decode('unicode_escape') if m else ''

        if api_canary:
            # Try via API
            api_headers = {
                **BROWSER_HEADERS,
                "Content-Type": "application/json",
                "canary": api_canary,
                "Origin": "https://account.live.com",
                "Referer": verify_url,
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
            }
            try:
                r = self.session.post(
                    "https://account.live.com/API/Proofs/SendOtt",
                    json={"ProofType": "Email", "ProofData": backup_email,
                          "Purpose": "AddProof"},
                    headers=api_headers,
                    allow_redirects=False,
                )
                print(f"[backup] SendOtt API: {r.status_code}")
                try:
                    resp_json = r.json()
                    if not resp_json.get('error'):
                        print("[backup] ✓ OTT requested via API")
                        return True
                    else:
                        print(f"[backup] SendOtt API error: {resp_json.get('error')}")
                except Exception:
                    pass
            except Exception as e:
                print(f"[backup] SendOtt API exception: {e}")

        # Method 2: Form - select Email radio and Submit
        # Search for radio with value containing email
        proof_value = None
        for m in re.finditer(r'value="(OTT\|\|[^"]*Email[^"]*)"', verify_html, re.IGNORECASE):
            proof_value = m.group(1).strip()
            break

        if not proof_value:
            # Try to find any radio with Email in value
            m = re.search(r'value="([^"]*notletters[^"]*|[^"]*firstmail[^"]*|[^"]*streetwor[^"]*|[^"]*beletters[^"]*|[^"]*oneletters[^"]*|[^"]*@[^"]+)"',
                          verify_html, re.IGNORECASE)
            if m:
                proof_value = m.group(1)

        canary = _extract_canary(verify_html)
        hidden = _extract_hidden_fields(verify_html)

        # Submit form with Email selection
        data = {
            **hidden,
            "proof": proof_value or f"OTT||{backup_email}||Email||0||a",
            "action": "SendOTT",
        }
        if canary:
            data["canary"] = canary

        try:
            resp = self.session.post(
                verify_url,
                data=data,
                headers={
                    **BROWSER_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://account.live.com",
                    "Referer": verify_url,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Sec-Fetch-Dest": "document",
                    "Sec-Fetch-Mode": "navigate",
                },
                allow_redirects=True,
            )
            print(f"[backup] SendOTT form: {resp.status_code}, URL: {resp.url[:80]}...")
            # If we got a code input page - good
            if any(x in resp.text.lower() for x in ["enter the code", "enter code", "iotttext", "verification"]):
                print("[backup] ✓ OTT requested via form")
                return True
        except Exception as e:
            print(f"[backup] SendOTT form exception: {e}")

        print("[backup] ⚠ Could not request OTT explicitly, trying to read IMAP anyway...")
        return False

    def verify_backup_email(self, code: str, canary: str = "",
                            verify_url: str = None,
                            hidden_fields: dict = None) -> bool:
        """
        Verify backup email with code from IMAP.
        """
        print(f"[backup] Verifying email with code: {code}...")

        url = verify_url or "https://account.live.com/proofs/Verify"
        data = {
            **(hidden_fields or {}),
            "iOttText": code,
            "action": "VerifyProof",
        }
        if canary:
            data["canary"] = canary

        resp = self.session.post(
            url,
            data=data,
            headers={
                **BROWSER_HEADERS,
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://account.live.com",
                "Referer": url,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
            },
            allow_redirects=True,
        )

        print(f"[backup] Verify: {resp.status_code}, URL: {resp.url[:100]}...")

        resp_lower = resp.text.lower()
        if 'id="fmHF"' in resp.text or "DoSubmit" in resp.text:
            print("[backup] ✓ Backup email verified! Found auto-submit form, returning response to continue OAuth.")
            return {"status": "success", "response": resp}

        if any(x in resp_lower for x in ["success", "verified", "manage"]):
            print("[backup] ✓ Backup email verified!")
            from urllib.parse import urlparse, parse_qs
            ru = parse_qs(urlparse(resp.url).query).get("ru", [None])[0]
            return {"status": "success", "response": resp, "ru": ru}

        print(f"[backup] ✗ Verification not confirmed")
        return {"status": "error", "message": "Verification failed"}

    def skip_proofs(self, proofs_url: str, proofs_html: str) -> dict:
        """
        Try to skip adding security proof (if possible).
        Looks for skip/cancel link on the page.
        """
        print("[backup] Trying to skip proofs/Add...")

        # Looking for skip link
        skip_match = re.search(
            r'<a[^>]*href="([^"]*)"[^>]*>(?:.*?(?:skip|cancel|later|not now).*?)</a>',
            proofs_html, re.IGNORECASE,
        )

        if skip_match:
            skip_url = skip_match.group(1).replace("&amp;", "&")
            if not skip_url.startswith("http"):
                skip_url = "https://account.live.com" + skip_url
            
            print(f"[backup] Skip URL: {skip_url[:80]}...")
            resp = self.session.get(skip_url, headers={
                **BROWSER_HEADERS,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": proofs_url,
            }, allow_redirects=True)

            if "code=" in resp.url:
                from urllib.parse import urlparse, parse_qs
                code = parse_qs(urlparse(resp.url).query).get("code", [None])[0]
                return {"status": "got_code", "code": code}

            return {"status": "skipped", "url": resp.url, "html": resp.text, "response": resp}

        print("[backup] Skip link not found")
        return {"status": "no_skip"}
