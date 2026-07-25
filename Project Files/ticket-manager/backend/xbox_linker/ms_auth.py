import re
import json
import time
from urllib.parse import urlparse, parse_qs, urlencode

from .config import (
    MICROSOFT_CLIENT_ID, XBOX_SCOPES, UBISOFT_APP_CLIENT_ID,
    MS_LOGIN_URL, MS_AUTHORIZE_URL, MS_CONSENT_URL,
    UBISOFT_XBOX_CALLBACK, BROWSER_HEADERS,
)
from .proxy_utils import create_session
from .backup_email import _extract_hidden_fields

def _parse_server_data(html: str) -> dict:
    
    match = re.search(r'var\s+ServerData\s*=\s*(\{.*?\})\s*;', html, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    return {}

def _extract_ppft_from_sft_tag(sft_tag: str) -> str:
    
    match = re.search(r'value="([^"]+)"', sft_tag)
    if match:
        return match.group(1)
    return ""

class MicrosoftAuth:
    

    def __init__(self, proxy: str = None):
        self.session = create_session(proxy, BROWSER_HEADERS)
        self.ppft = None
        self.url_post = None
        self.url_gct = None
        self.server_data = {}
        self.pre_auth_result = None

    def start_oauth(self) -> bool:
        
        print("[ms] Step 1: Initializing OAuth...")

        auth_url = (
            f"{MS_AUTHORIZE_URL}?client_id={UBISOFT_APP_CLIENT_ID}"
            f"&response_type=code"
            f"&scope=XboxLive.signin XboxLive.offline_access"
            f"&redirect_uri={UBISOFT_XBOX_CALLBACK}"
        )
        self.auth_url = auth_url

        resp = self.session.get(auth_url, headers=BROWSER_HEADERS, allow_redirects=True)

        if resp.status_code != 200:
            print(f"[ms] Error: status {resp.status_code}")
            return False

        print(f"[ms] OAuth GET URL: {resp.url[:100]}...")

        if "code=" in resp.url:
            code = parse_qs(urlparse(resp.url).query).get("code", [None])[0]
            self.pre_auth_result = {"status": "got_code", "code": code}
            return True

        if "Consent" in resp.url or "consent" in resp.text.lower():
            canary = self._extract_canary(resp.text)
            self.pre_auth_result = {"status": "need_consent", "canary": canary, "url": resp.url, "html": resp.text}
            return True

        if 'id="fmHF"' in resp.text:
            print("[ms] OAuth init: found auto-submit form, following...")
            form_result = self._handle_auto_submit_form(resp)
            if form_result:
                self.pre_auth_result = form_result
                return True

        self.server_data = _parse_server_data(resp.text)

        if not self.server_data:
            print(f"[ms] ServerData not found in HTML. HTML len: {len(resp.text)}")
            return False

        sft_tag = self.server_data.get("sFTTag", "")
        self.ppft = _extract_ppft_from_sft_tag(sft_tag)

        self.url_post = self.server_data.get("urlPost", "")

        self.url_gct = self.server_data.get("urlGetCredentialType", "")

        if self.ppft and self.url_post:
            print(f"[ms] OAuth OK. PPFT: {self.ppft[:30]}...")
            print(f"[ms] urlPost: {self.url_post[:80]}...")
            return True
        else:
            print(f"[ms] PPFT: {'OK' if self.ppft else 'MISSING'}")
            print(f"[ms] urlPost: {'OK' if self.url_post else 'MISSING'}")
            return False

    def _get_credential_type(self, email: str) -> str:
        
        if not self.url_gct:
            return self.ppft

        print(f"[ms] GetCredentialType for {email}...")

        gct_data = {
            "username": email,
            "uaid": self.server_data.get("sUnauthSessionID", ""),
            "isOtherIdpSupported": True,
            "checkPhones": False,
            "isRemoteNGCSupported": True,
            "isCookieBannerShown": False,
            "isFidoSupported": False,
            "flowToken": self.ppft,
            "country": "US",
        }

        resp = self.session.post(
            self.url_gct,
            json=gct_data,
            headers={
                **BROWSER_HEADERS,
                "Content-Type": "application/json",
                "Referer": self.server_data.get("urlLogin", MS_AUTHORIZE_URL),
            },
        )

        if resp.status_code == 200:
            result = resp.json()
            new_ft = result.get("FlowToken", self.ppft)
            if new_ft and new_ft != self.ppft:
                print(f"[ms] FlowToken updated")
                self.ppft = new_ft
            exists = result.get("IfExistsResult")
            print(f"[ms] IfExistsResult: {exists}")
        else:
            print(f"[ms] GCT error: {resp.status_code}")

        return self.ppft

    def login(self, email: str, password: str) -> dict:
        
        if self.pre_auth_result:
            print("[ms] Already authenticated, returning start_oauth result")
            return self.pre_auth_result

        if not self.ppft or not self.url_post:
            raise RuntimeError("Call start_oauth() first()")

        self._get_credential_type(email)
        time.sleep(0.5)

        print(f"[ms] Step 2: Login {email}...")

        data = {
            "login": email,
            "loginfmt": email,
            "type": "11",
            "LoginOptions": "3",
            "passwd": password,
            "ps": "2",
            "PPFT": self.ppft,
            "PPSX": "Passport",
            "NewUser": "1",
            "fspost": "0",
            "i21": "0",
            "CookieDisclosure": "0",
            "IsFidoSupported": "0",
            "isSignupPost": "0",
        }

        headers = {
            **BROWSER_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Origin": MS_LOGIN_URL,
            "Referer": self.server_data.get("urlLogin", MS_AUTHORIZE_URL),
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }

        resp = self.session.post(self.url_post, data=data, headers=headers, allow_redirects=True)
        final_url = resp.url

        print(f"[ms] Status: {resp.status_code}")
        print(f"[ms] URL: {final_url[:100]}...")

        if resp.status_code == 429:
            print("[ms] ✗ Rate limited (429)")
            return {"status": "error", "message": "Rate limited (429)"}

        query = parse_qs(urlparse(final_url).query)
        if "code" in query:
            code = query["code"][0]
            print(f"[ms] ✓ Code obtained immediately!")
            return {"status": "got_code", "code": code}

        resp_sd = _parse_server_data(resp.text)

        err_txt = resp_sd.get("sErrTxt", "")
        if err_txt:
            print(f"[ms] ✗ Error: {err_txt}")
            return {"status": "error", "message": err_txt}

        if resp_sd.get("fHasError"):
            msg = resp_sd.get("sErrorMsg", "Unknown error (fHasError=True)")
            print(f"[ms] ✗ fHasError: {msg}")
            return {"status": "error", "message": msg}

        if "Consent" in final_url or "consent" in resp.text.lower():
            canary = self._extract_canary(resp.text)
            print(f"[ms] -> Consent needed")
            return {"status": "need_consent", "canary": canary, "url": final_url, "html": resp.text}

        pgid = resp_sd.get("pgid", "")
        url_stay = resp_sd.get("urlStaySignIn", "")
        has_urlpost = bool(resp_sd.get("urlPost", ""))
        has_ppft = bool(resp_sd.get("sFTTag", "") or resp_sd.get("sFT", ""))

        if has_urlpost and has_ppft and not err_txt:
            print("[ms] -> Post-login page (KMSI/redirect), handling...")
            return self._handle_stay_signed_in(resp, resp_sd)

        if "identity/confirm" in final_url:
            print("[ms] -> Confirming 'Is your security info accurate?' (identity/confirm)")
            hidden = _extract_hidden_fields(resp.text)
            r = self.session.post(final_url, data={**hidden, "action": "LooksGood"}, headers=headers, allow_redirects=True)
            if "code=" in r.url:
                code = parse_qs(urlparse(r.url).query).get("code", [None])[0]
                return {"status": "got_code", "code": code}
            final_url = r.url
            resp = r

        if pgid in ("Verify", "ProofConfirmation"):
            print("[ms] -> Requires 2FA (Verify/ProofConfirmation)")
            return {"status": "need_2fa", "url": final_url}

        form_result = self._handle_auto_submit_form(resp)
        if form_result:
            return form_result

        return {"status": "unknown", "url": final_url, "pgid": pgid, "html": resp.text}

    def _handle_auto_submit_form(self, resp) -> dict | None:
        
        html = resp.text

        form_match = re.search(
            r'<form[^>]*id="fmHF"[^>]*action="([^"]+)"[^>]*method="post"',
            html, re.IGNORECASE,
        )
        if not form_match:
            return None

        form_action = form_match.group(1)
        form_action = form_action.replace("&amp;", "&")

        # Resolve relative URLs (e.g. /handlers/languagesave.mvc)
        if form_action.startswith("/"):
            form_action = "https://account.live.com" + form_action
        elif not form_action.startswith("http"):
            form_action = "https://account.live.com/" + form_action

        print(f"[ms] -> Auto-submit form: {form_action[:80]}...")

        hidden_fields = {}
        for m in re.finditer(
            r'<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"',
            html, re.IGNORECASE,
        ):
            hidden_fields[m.group(1)] = m.group(2)

        print(f"[ms] Hidden fields: {list(hidden_fields.keys())}")

        r = self.session.post(
            form_action,
            data=hidden_fields,
            headers={
                **BROWSER_HEADERS,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "cross-site",
                "Upgrade-Insecure-Requests": "1",
            },
            allow_redirects=True,
        )

        print(f"[ms] Form submit -> {r.status_code}, URL: {r.url[:100]}...")

        query = parse_qs(urlparse(r.url).query)
        if "code" in query:
            code = query["code"][0]
            print(f"[ms] ✓ Code obtained!")
            return {"status": "got_code", "code": code}

        if "Consent" in r.url:
            canary = self._extract_canary(r.text)
            return {"status": "need_consent", "canary": canary, "url": r.url, "html": r.text}

        if "proofs/Add" in r.url or "proofs/add" in r.url:
            print("[ms] -> Security proof setup page (backup email)")
            return {
                "status": "need_proofs",
                "url": r.url,
                "html": r.text,
                "session": self.session,
            }
            

        if "account.live.com/recover" in r.url:
            print("[ms] ✗ Account blocked, needs recovery (SMS or password reset).")
            return {"status": "error", "message": "Account blocked: needs recovery"}

        if "account.live.com/Abuse" in r.url or "/Abuse?" in r.url:
            print("[ms] ✗ Account flagged for abuse - Microsoft blocked login (too many attempts).")
            print("[ms]   Wait 30-60 minutes before retrying this account.")
            return {"status": "error", "message": "Account blocked: abuse/suspicious activity"}

        if "identity/confirm" in r.url:
            if "LooksGood" in r.text or "Is your security info accurate" in r.text:
                print("[ms] -> Confirming 'Is your security info accurate?' (LooksGood)")
                hidden = _extract_hidden_fields(r.text)
                r2 = self.session.post(r.url, data={**hidden, "action": "LooksGood"}, headers={
                    **BROWSER_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": r.url,
                }, allow_redirects=True)
                query = parse_qs(urlparse(r2.url).query)
                if "code" in query:
                    code = query["code"][0]
                    print(f"[ms] ✓ Code obtained after LooksGood!")
                    return {"status": "got_code", "code": code}
                
                nested_form = re.search(r'<form[^>]*id="fmHF"[^>]*action="([^"]+)"', r2.text, re.IGNORECASE)
                if nested_form:
                    print("[ms] -> Nested auto-submit form after LooksGood, following...")
                    return self._handle_auto_submit_form(r2)
                
                return {"status": "unknown", "url": r2.url}
            else:
                print("[ms] -> Verification required 'Help us protect your account' (identity/confirm)")
                return {
                    "status": "need_verify_existing",
                    "url": r.url,
                    "html": r.text,
                    "session": self.session,
                }

        nested_form = re.search(
            r'<form[^>]*id="fmHF"[^>]*action="([^"]+)"',
            r.text, re.IGNORECASE,
        )
        if nested_form:
            action = nested_form.group(1).replace("&amp;", "&")
            if "proofs/Add" in action:
                print("[ms] -> Nested proofs/Add form found")
                return {
                    "status": "need_proofs",
                    "url": action,
                    "html": r.text,
                    "session": self.session,
                }
            print("[ms] -> Nested auto-submit form, following...")
            return self._handle_auto_submit_form(r)

        return {"status": "unknown", "url": r.url}

    def _handle_stay_signed_in(self, resp, resp_sd: dict) -> dict:
        
        print("[ms] Confirming Stay Signed In...")

        url_post = resp_sd.get("urlPost", "")
        sft_tag = resp_sd.get("sFTTag", "")
        ppft = _extract_ppft_from_sft_tag(sft_tag) if sft_tag else resp_sd.get("sFT", "")
        ppft = ppft or self.ppft

        if not url_post:
            return {"status": "unknown", "url": resp.url, "error": "no urlPost in KMSI", "html": resp.text}

        data = {
            "LoginOptions": "1",
            "type": "28",
            "ctx": resp_sd.get("sCtx", ""),
            "hpgrequestid": resp_sd.get("sessionId", ""),
            "PPFT": ppft,
            "i19": str(int(time.time() * 1000)),
        }

        r = self.session.post(
            url_post,
            data=data,
            headers={
                **BROWSER_HEADERS,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Origin": MS_LOGIN_URL,
                "Referer": resp.url,
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "Upgrade-Insecure-Requests": "1",
            },
            allow_redirects=True,
        )

        print(f"[ms] KMSI -> Status: {r.status_code}, URL: {r.url[:100]}...")

        return self._resolve_post_login(r)

    def _resolve_post_login(self, r) -> dict:
        
        for hop in range(8):
            url = r.url

            if "code=" in url:
                code = parse_qs(urlparse(url).query).get("code", [None])[0]
                if code:
                    print(f"[ms] ✓ Code obtained!")
                    return {"status": "got_code", "code": code}

            if "account.live.com/recover" in url:
                print("[ms] ✗ Account blocked")
                return {"status": "error", "message": "Account blocked: needs recovery"}

            if "account.live.com/Abuse" in url or "/Abuse?" in url:
                print("[ms] ✗ Account flagged for abuse")
                return {"status": "error", "message": "Account blocked: abuse/suspicious activity"}

            if "proofs/Add" in url or "proofs/add" in url:
                print("[ms] -> Security proof setup page (backup email)")
                return {"status": "need_proofs", "url": url, "html": r.text, "session": self.session}

            if "identity/confirm" in url:
                if "LooksGood" in r.text or "Is your security info accurate" in r.text:
                    print("[ms] -> Confirming 'Is your security info accurate?' (LooksGood)")
                    hidden = _extract_hidden_fields(r.text)
                    r = self.session.post(url, data={**hidden, "action": "LooksGood"}, headers={
                        **BROWSER_HEADERS,
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Referer": url,
                    }, allow_redirects=True)
                    print(f"[ms] LooksGood -> {r.status_code}, URL: {r.url[:100]}...")
                    continue
                else:
                    print("[ms] -> Verification required 'Help us protect your account' (identity/confirm)")
                    return {"status": "need_verify_existing", "url": url, "html": r.text, "session": self.session}

            # Check fmHF BEFORE Consent URL check:
            # After a successful consent POST, Microsoft redirects to oauth20_authorize
            # which contains an fmHF auto-submit pointing back to Consent/Update.
            # This must be followed automatically, not treated as a user-facing consent prompt.
            form_match = re.search(
                r'<form[^>]*id="fmHF"[^>]*action="([^"]+)"[^>]*method="post"',
                r.text, re.IGNORECASE,
            )
            if form_match:
                action = form_match.group(1).replace("&amp;", "&")
                hidden = {}
                for m in re.finditer(
                    r'<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"',
                    r.text, re.IGNORECASE,
                ):
                    hidden[m.group(1)] = m.group(2)
                for m in re.finditer(
                    r'<input[^>]*value="([^"]*)"[^>]*name="([^"]*)"[^>]*type="hidden"',
                    r.text, re.IGNORECASE,
                ):
                    hidden[m.group(2)] = m.group(1)

                print(f"[ms] -> fmHF auto-submit (hop {hop+1}): {action[:80]}...")
                r = self.session.post(action, data=hidden, headers={
                    **BROWSER_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Sec-Fetch-Dest": "document",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "cross-site",
                }, allow_redirects=True)
                print(f"[ms] fmHF -> {r.status_code}, URL: {r.url[:100]}...")
                continue

            # Only return need_consent if page is genuinely a user-facing consent form
            # (has ServerData with arrConsentInfoServerData, meaning user must click Accept/Deny)
            if "Consent" in url:
                sd_c = _parse_server_data(r.text)
                if sd_c.get("arrConsentInfoServerData") or sd_c.get("sCanary"):
                    canary = self._extract_canary(r.text)
                    return {"status": "need_consent", "canary": canary, "url": url, "html": r.text}
                # Consent URL but no user-facing data - might be a redirect page, keep trying
                print(f"[ms] -> Consent URL without user form, checking for redirects...")

            sd = _parse_server_data(r.text)
            if sd.get("sErrTxt"):
                return {"status": "error", "message": sd["sErrTxt"]}

            break

        with open('debug_unknown.html', 'w') as f:
            f.write(r.text)
        return {"status": "unknown", "url": r.url, "html": r.text}

    def get_xbox_access_token(self) -> str | None:
        """
        Fetches Microsoft Access Token for use with the Xbox Live API (profile creation).
        Called after successful login.
        """
        print("[ms] Fetching Microsoft Access Token for Xbox Live...")
        
        # Request token (response_type=token) for Xbox Live
        url = (
            f"{MS_AUTHORIZE_URL}?client_id=00000000402b5328"
            f"&response_type=token"
            f"&scope=service::user.auth.xboxlive.com::MBI_SSL"
            f"&redirect_uri=https://login.live.com/oauth20_desktop.srf"
        )
        
        resp = self.session.get(url, headers=BROWSER_HEADERS, allow_redirects=True)
        
        # If Microsoft requires consent even for this token
        if 'id="fmHF"' in resp.text:
            print("[ms] -> fmHF auto-submit form while fetching access token...")
            result = self._resolve_post_login(resp)
            final_url = result.get("url", resp.url)
        else:
            final_url = resp.url
            
            # Handle consent if it appears
            if "Consent" in final_url:
                canary = self._extract_canary(resp.text)
                self.submit_consent(canary, consent_url=final_url, consent_html=resp.text)
                # Retry request after consent
                resp = self.session.get(url, headers=BROWSER_HEADERS, allow_redirects=True)
                if 'id="fmHF"' in resp.text:
                    result = self._resolve_post_login(resp)
                    final_url = result.get("url", resp.url)
                else:
                    final_url = resp.url
        
        # Token is returned in the URL fragment (#access_token=...)
        if "access_token=" in final_url:
            frag = urlparse(final_url).fragment
            params = parse_qs(frag)
            token = params.get("access_token", [None])[0]
            if token:
                print(f"[ms] ✓ Xbox Access Token obtained!")
                return token
                
        print(f"[ms] ✗ Failed to obtain Xbox Access Token. URL: {final_url[:100]}")
        return None

    def submit_consent(self, canary: str, consent_url: str = None, consent_html: str = None) -> str | None:
        
        print("[ms] Step 3: Submitting consent...")

        url = consent_url or MS_CONSENT_URL

        if consent_html:
            with open('debug_consent_page.html', 'w') as f:
                f.write(consent_html)

        # Extract canary and scopes from ServerData (React SPA consent page)
        consent_canary = canary
        consent_scopes = XBOX_SCOPES

        if consent_html:
            sd = _parse_server_data(consent_html)
            
            # Use sCanary from ServerData if available (React consent page)
            s_canary = sd.get('sCanary', '')
            if s_canary:
                consent_canary = s_canary.encode().decode('unicode_escape')
                print(f"[ms] Using sCanary from ServerData")
            
            raw_scopes = sd.get('sRawInputScopes', '')
            if raw_scopes:
                consent_scopes = raw_scopes.encode().decode('unicode_escape')

            consent_info = sd.get('arrConsentInfoServerData', [])
            if consent_info:
                print(f"[ms] Consent for: {consent_info[0].get('sAppName', '?')}")
            print(f"[ms] Consent scopes: {consent_scopes}")

        # Include any hidden fields from the HTML (legacy pages only; React SPA has none)
        hidden = {}
        if consent_html:
            hidden = _extract_hidden_fields(consent_html)

        # The consent_client_id MUST match the client ID of the consent page itself.
        # This is typically sClientId from ServerData.
        consent_client_id = sd.get('sClientId', '') if consent_html else ''
        if not consent_client_id:
            consent_client_id = parse_qs(urlparse(url).query).get('client_id', [None])[0]
        if not consent_client_id:
            consent_client_id = MICROSOFT_CLIENT_ID

        data = {
            **hidden,
            "ucaction": "Yes",
            "canary": consent_canary,
            "client_id": consent_client_id,
            "sRawInputScopes": consent_scopes,
            "scope": consent_scopes,
            "scopes": consent_scopes
        }

        print(f"[ms] Consent POST keys: {list(data.keys())}, client_id={consent_client_id}")

        headers = {
            **BROWSER_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://account.live.com",
            "Referer": url,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }

        resp = self.session.post(url, data=data, headers=headers, allow_redirects=True)

        # Log the full redirect chain for debugging
        print(f"[ms] Consent redirect chain: {len(resp.history)} hops")
        for i, r in enumerate(resp.history):
            loc = r.headers.get('Location', '?')
            print(f"[ms]   [{i+1}] {r.status_code} -> {loc[:120]}")
        print(f"[ms] Consent -> Status: {resp.status_code}, URL: {resp.url[:120]}...")

        query = parse_qs(urlparse(resp.url).query)
        if "code" in query:
            code = query["code"][0]
            print(f"[ms] ✓ Code obtained!")
            return code

        if 'id="fmHF"' in resp.text or 'ServerData' in resp.text:
            result = self._resolve_post_login(resp)
            if result.get("status") == "got_code":
                return result["code"]
            
            # Handle chained consent pages (e.g. Xbox Live consent, then Ubisoft consent)
            if result.get("status") == "need_consent":
                print("[ms] Additional consent required, submitting again...")
                # Extract canary from the new consent page
                new_html = result.get("html", "")
                new_url = result.get("url", resp.url)
                new_canary = self._extract_canary(new_html)
                return self.submit_consent(new_canary, new_url, new_html)

            print(f"[ms] ✗ _resolve_post_login returned: {result.get('status')}")
            if "html" in result:
                with open('debug_second_consent.html', 'w') as f:
                    f.write(result["html"])
                print(f"[ms] Saved post-login result to debug_second_consent.html")

        # Check if we got redirected to error
        if "error" in query:
            err = query.get("error", [""])[0]
            err_desc = query.get("error_description", [""])[0]
            print(f"[ms] ✗ Consent error: {err} - {err_desc}")

        print(f"[ms] ✗ Code not obtained. URL: {resp.url}")
        # Save full response body for diagnosis
        with open('debug_consent.html', 'w') as f:
            f.write(resp.text)
        # Also print first 500 chars of body
        print(f"[ms] Response body (first 500): {resp.text[:500]}")
        return None

    def _extract_canary(self, html: str) -> str:
        
        match = re.search(r'name="canary"\s*value="([^"]+)"', html)
        if match:
            return match.group(1)
        match = re.search(r'"canary"\s*:\s*"([^"]+)"', html)
        if match:
            return match.group(1)
        sd = _parse_server_data(html)
        return sd.get("canary", "")

    def verify_identity_confirm(self, confirm_html: str, confirm_url: str,
                                 backup_email: str, imap_email: str,
                                 imap_password: str, imap_host: str) -> dict:
        
        from .imap_helper import IMAPCodeReader

        # --- Extract proof email from HTML form radio buttons ---
        proof_email = None

        # Method 1: Parse from form radio button values (primary)
        for fm in re.finditer(r'value="OTT\|\|([^|]+)\|\|Email', confirm_html):
            candidate = fm.group(1).strip()
            if '@' in candidate:
                proof_email = candidate
                break

        # Method 2: Parse from page title (fallback)
        if not proof_email:
            tm = re.search(r'<title>[^<]*?([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)', confirm_html)
            if tm:
                proof_email = tm.group(1)

        # Method 3: rawProofList JSON (legacy fallback)
        if not proof_email:
            m = re.search(r'"rawProofList"\s*:\s*"(.*?)"', confirm_html)
            if m:
                try:
                    proofs = json.loads(m.group(1).encode().decode('unicode_escape'))
                    for p in proofs:
                        if p.get('type') == 'Email':
                            proof_email = p.get('name', '')
                            break
                except Exception:
                    pass

        if not proof_email:
            print(f"[ms] ✗ No email proof found on identity/confirm page")
            with open('debug_verify_raw.html', 'w') as f:
                f.write(confirm_html)
            return {"status": "error", "message": "No email proof available"}

        print(f"[ms] -> Proof email on account: {proof_email}")

        # Determine IMAP credentials for reading the code
        imap_target_email = imap_email
        imap_target_password = imap_password
        imap_target_host = imap_host

        proof_domain = proof_email.split('@')[1] if '@' in proof_email else ''
        imap_domain = imap_email.split('@')[1] if '@' in imap_email else ''

        if proof_domain != imap_domain:
            print(f"[ms] ℹ Proof email domain ({proof_domain}) differs from IMAP domain ({imap_domain})")
            print(f"[ms]   This is expected: {proof_email} is an addy.to/addymail alias that forwards to {imap_email}")
            print(f"[ms]   Reading IMAP from {imap_email} (the real mailbox that receives forwards)")
            # Keep imap_target_email = imap_email  ← DO NOT override with proof_email!
            # The imap_email is rambler.ru/mail.ru which receives forwarded emails from the alias


        # === STEP 1: Request OTT via FORM (avoids 6002 API error) ===
        # Find the proof radio value matching proof_email
        proof_radio_value = None
        for fm in re.finditer(r'value="(OTT\|\|[^"]*)"', confirm_html):
            v = fm.group(1)
            if proof_email.split('@')[0].lower()[:4] in v.lower() or proof_email in v:
                proof_radio_value = v
                break
        if not proof_radio_value:
            m = re.search(r'value="(OTT\|\|[^"]+)"', confirm_html)
            proof_radio_value = m.group(1) if m else f"OTT||{proof_email}||Email||0||a"

        canary = self._extract_canary(confirm_html)
        hidden = _extract_hidden_fields(confirm_html)

        # Find form action URL
        form_action_match = re.search(r'<form[^>]*action="([^"]*)"[^>]*method="post"', confirm_html, re.IGNORECASE)
        if not form_action_match:
            form_action_match = re.search(r'<form[^>]*method="post"[^>]*action="([^"]*)"', confirm_html, re.IGNORECASE)
        form_action = form_action_match.group(1).replace("&amp;", "&") if form_action_match else confirm_url
        # Resolve relative URLs
        if form_action.startswith("/"):
            form_action = "https://account.live.com" + form_action
        elif form_action and not form_action.startswith("http"):
            form_action = "https://account.live.com/" + form_action

        send_data = {
            **hidden,
            "proof": proof_radio_value,
            "action": "SendOTT",
        }
        if canary:
            send_data["canary"] = canary

        print(f"[ms] -> Sending OTT to {proof_email} via FORM (SendOTT)...")
        try:
            r_send = self.session.post(
                form_action,
                data=send_data,
                headers={
                    **BROWSER_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://account.live.com",
                    "Referer": confirm_url,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Sec-Fetch-Dest": "document",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "same-origin",
                },
                allow_redirects=True,
            )
            print(f"[ms] SendOTT form: {r_send.status_code}, URL: {r_send.url[:100]}")
            if "error.aspx" in r_send.url:
                print("[ms] ⚠️ Microsoft rate limited code requests (errcode=1078). Wait 1-2 minutes before retrying.")
                return {"status": "rate_limited", "message": "Microsoft rate limited code requests (errcode=1078)"}

            if any(x in r_send.text.lower() for x in ["enter the code", "iotttext", "enter code", "verification"]):
                print("[ms] ✓ OTT sent! Code input page received.")
                confirm_html = r_send.text
                confirm_url = r_send.url
            else:
                print("[ms] ⚠ Code input page not detected after SendOTT, trying IMAP anyway...")
        except Exception as e:
            print(f"[ms] SendOTT form exception: {e}, trying IMAP anyway...")

        # === STEP 2: Wait and read code via IMAP ===
        print("[ms] Waiting 8s for email delivery...")
        import time as _time
        _time.sleep(8)

        imap = IMAPCodeReader(imap_target_email, imap_target_password, imap_target_host)
        try:
            imap.connect()
            code = imap.get_verification_code(max_wait=120)
        finally:
            imap.close()

        if not code:
            print("[ms] ✗ Code not received via IMAP")
            return {"status": "error", "message": "No IMAP code"}

        print(f"[ms] -> Verifying code {code}...")

        # === STEP 3: Submit code via FORM ===
        verify_hidden = _extract_hidden_fields(confirm_html)
        verify_canary = self._extract_canary(confirm_html)

        vform_match = re.search(r'<form[^>]*action="([^"]*)"[^>]*method="post"', confirm_html, re.IGNORECASE)
        if not vform_match:
            vform_match = re.search(r'<form[^>]*method="post"[^>]*action="([^"]*)"', confirm_html, re.IGNORECASE)
        verify_form_action = vform_match.group(1).replace("&amp;", "&") if vform_match else confirm_url
        # Resolve relative URLs
        if verify_form_action.startswith("/"):
            verify_form_action = "https://account.live.com" + verify_form_action
        elif verify_form_action and not verify_form_action.startswith("http"):
            verify_form_action = "https://account.live.com/" + verify_form_action

        verify_data = {
            **verify_hidden,
            "iOttText": code,
            "action": "VerifyProof",
        }
        if verify_canary:
            verify_data["canary"] = verify_canary

        r2 = self.session.post(
            verify_form_action,
            data=verify_data,
            headers={
                **BROWSER_HEADERS,
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://account.live.com",
                "Referer": confirm_url,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
            },
            allow_redirects=True,
        )
        print(f"[ms] VerifyCode form: {r2.status_code}, URL: {r2.url[:100]}")

        if any(x in r2.text.lower() for x in ["that code didn", "incorrect code", "invalid code", "error_1203", "error_1215"]):
            print("[ms] ✗ Wrong code entered")
            return {"status": "error", "message": "Wrong verification code"}

        print("[ms] ✓ Code submitted!")

        # === STEP 4: Follow redirect ===
        if "code=" in r2.url:
            auth_code = parse_qs(urlparse(r2.url).query).get("code", [None])[0]
            return {"status": "got_code", "code": auth_code}

        if 'id="fmHF"' in r2.text:
            return self._handle_auto_submit_form(r2) or {"status": "unknown", "url": r2.url}

        if "Consent" in r2.url:
            canary_new = self._extract_canary(r2.text)
            return {"status": "need_consent", "canary": canary_new, "url": r2.url, "html": r2.text}

        # Last resort: re-request auth URL
        r3 = self.session.get(self.auth_url, headers=BROWSER_HEADERS, allow_redirects=True)
        print(f"[ms] Auth URL recheck: {r3.url[:100]}")
        return self._resolve_post_login(r3)

    def follow_posturl_chain(self, verify_resp) -> dict:
        
        print("[ms] -> Restarting OAuth flow after verification...")
        r = self.session.get(self.auth_url, headers=BROWSER_HEADERS, allow_redirects=True)
        print(f"[ms] OAuth restart -> {r.status_code}, URL: {r.url[:100]}...")
        return self._resolve_post_login(r)
