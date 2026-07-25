"""
Xbox Profile - profile creation and token exchange.
"""

import json
from .config import BROWSER_HEADERS, XBOX_USER_URL, XBOX_XSTS_URL, XBOX_PROFILE_URL


class XboxProfile:
    """Xbox profile creation on a Microsoft account."""

    def __init__(self, session):
        self.session = session
        self.xbox_token = None
        self.user_hash = None

    def get_xbox_token(self, access_token: str) -> dict | None:
        """
        Exchanges Microsoft access_token for an Xbox User Token.

        Args:
            access_token: Microsoft OAuth access token

        Returns:
            dict with Token and UserHash, or None
        """
        print("[xbox] Fetching Xbox User Token...")

        payload = {
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": f"t={access_token}",
            },
        }

        resp = self.session.post(
            XBOX_USER_URL,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-xbl-contract-version": "1",
            },
        )

        if resp.status_code == 200:
            data = resp.json()
            self.xbox_token = data.get("Token")
            self.user_hash = data.get("DisplayClaims", {}).get("xui", [{}])[0].get("uhs")
            print(f"[xbox] User Token obtained. UserHash: {self.user_hash}")
            return {"token": self.xbox_token, "user_hash": self.user_hash}
        else:
            print(f"[xbox] Error: {resp.status_code} - {resp.text[:200]}")
            return None

    def get_xsts_token(self) -> dict | None:
        """
        Exchanges Xbox User Token for an XSTS Token.
        """
        if not self.xbox_token:
            raise RuntimeError("Call get_xbox_token first")

        print("[xbox] Fetching XSTS Token...")

        payload = {
            "RelyingParty": "http://xboxlive.com",
            "TokenType": "JWT",
            "Properties": {
                "UserTokens": [self.xbox_token],
                "SandboxId": "RETAIL",
            },
        }

        resp = self.session.post(
            XBOX_XSTS_URL,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-xbl-contract-version": "1",
            },
        )

        if resp.status_code == 200:
            data = resp.json()
            xsts_token = data.get("Token")
            print(f"[xbox] XSTS Token obtained")
            return {"token": xsts_token, "data": data}
        else:
            print(f"[xbox] XSTS error: {resp.status_code} - {resp.text[:200]}")
            return None

    def create_profile(self) -> bool:
        """
        Creates an Xbox profile (gamertag) if it doesn't exist yet.
        """
        if not self.xbox_token or not self.user_hash:
            raise RuntimeError("Call get_xbox_token first")

        print("[xbox] Creating Xbox profile...")

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"XBL3.0 x={self.user_hash};{self.xbox_token}",
            "x-xbl-contract-version": "4",
        }

        # Profile creation request
        payload = {
            "partnerOptInChoice": [],
            "msftOptInChoice": False,
        }

        resp = self.session.post(
            XBOX_PROFILE_URL,
            json=payload,
            headers=headers,
        )

        if resp.status_code in (200, 201):
            print("[xbox] ✓ Profile created!")
            try:
                data = resp.json()
                gamertag = data.get("gamertag", "unknown")
                print(f"[xbox] Gamertag: {gamertag}")
            except Exception:
                pass
            return True
        elif resp.status_code == 409:
            print("[xbox] Profile already exists - OK")
            return True
        else:
            print(f"[xbox] Profile creation error: {resp.status_code} - {resp.text[:200]}")
            return False
