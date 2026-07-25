import base64
import json
import asyncio
import aiohttp
from typing import Optional, Dict, Any, Tuple

TICKET_APP_ID = "4391c956-8943-48eb-8859-07b0778f47b9"
GENOME_ID = "1a6f2698-1350-416e-b8e8-29d77fb86437"

class UbisoftApiPython:
    """
    Python Ubisoft API Client
    Handles Basic Auth authentication, Session Elevation (TICKET scope),
    and CSHelp Account Recovery ticket creation.
    """
    def __init__(self, login: str, proxy: Optional[str] = None):
        self.proxy = f"http://{proxy}" if proxy else None
        if ":" in login:
            self.email, self.password = login.split(":", 1)
        else:
            self.email, self.password = login, ""
        self.base_url = "https://public-ubiservices.ubi.com"
        self.token: Optional[str] = None
        self.session_id: Optional[str] = None
        self.profile_id: Optional[str] = None
        self.user_id: Optional[str] = None

        self.base_headers = {
            "Ubi-AppId": "2c2d31af-4ee4-4049-85dc-00dc74aef88f",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Ubi-RequestedPlatformType": "uplay",
            "Ubi-LocaleCode": "en-US",
        }

    async def _request(
        self, endpoint: str, method: str = "POST", headers: Optional[Dict] = None, json_data: Optional[Dict] = None
    ) -> Tuple[bool, Any, int]:
        url = f"{self.base_url}{endpoint}"
        req_headers = headers if headers else self.base_headers
        kwargs = {"headers": req_headers}
        if json_data:
            kwargs["json"] = json_data
        if self.proxy:
            kwargs["proxy"] = self.proxy

        try:
            async with aiohttp.ClientSession() as session:
                async with session.request(method, url, **kwargs) as resp:
                    text = await resp.text()
                    try:
                        data = json.loads(text)
                    except Exception:
                        data = text
                    return (resp.status in (200, 201), data, resp.status)
        except Exception as e:
            return (False, {"error": str(e)}, 500)

    async def authenticate(self) -> Tuple[bool, Any]:
        """Step 1: Basic Authentication to get initial user token"""
        creds = f"{self.email}:{self.password}"
        encoded = base64.b64encode(creds.encode()).decode()
        headers = self.base_headers.copy()
        headers["Authorization"] = f"Basic {encoded}"

        ok, data, status = await self._request("/v3/profiles/sessions", method="POST", headers=headers, json_data={"rememberMe": True})
        if ok and isinstance(data, dict):
            self.token = data.get("ticket")
            self.session_id = data.get("sessionId")
            self.profile_id = data.get("profileId")
            self.user_id = data.get("userId")
            return True, data
        return False, data

    async def elevate_session(self) -> Tuple[bool, Any]:
        """Step 2: Session Elevation to TICKET_APP_ID scope for CSHelp API access"""
        if not self.token:
            return False, "Not authenticated"

        headers = self.base_headers.copy()
        headers["Ubi-AppId"] = TICKET_APP_ID
        headers["Authorization"] = f"ubi_v1 t={self.token}"

        ok, data, status = await self._request("/v3/profiles/sessions", method="POST", headers=headers, json_data={"rememberMe": False})
        if ok and isinstance(data, dict):
            self.token = data.get("ticket")
            self.session_id = data.get("sessionId")
            return True, data
        return False, data

    async def create_account_recovery_ticket(
        self, username: str, contact_email: str, lost_email: str, captcha_token: str
    ) -> Tuple[bool, Any]:
        """Step 3: Submit Case to CSHelp Account Recovery API"""
        if not self.token or not self.session_id:
            return False, "No elevated session available"

        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
            "Referer": "https://www.ubisoft.com/",
            "Origin": "https://www.ubisoft.com",
            "Ubi-AppId": TICKET_APP_ID,
            "Authorization": f"ubi_v1 t={self.token}",
            "Ubi-SessionId": self.session_id,
            "Ubi-GenomeId": GENOME_ID,
            "Accept": "*/*",
        }

        payload = {
            "Case": {
                "accountRecoveryReason": "accountHackedOrTakenOver",
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
            "token": captcha_token,
        }

        ok, data, status = await self._request(
            "/v1/applications/global/cshelp/cases/api/account-recovery-cases",
            method="POST",
            headers=headers,
            json_data=payload,
        )
        return ok, data
