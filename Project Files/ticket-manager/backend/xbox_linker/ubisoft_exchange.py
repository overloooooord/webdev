import json
from .config import UBISOFT_TOKEN_URL, UBISOFT_XBOX_CALLBACK, BROWSER_HEADERS

class UbisoftExchange:
    

    def __init__(self, session):
        self.session = session

    def exchange_code(self, code: str) -> dict | None:
        
        print("[ubi] Exchanging code for Ubisoft token...")

        headers = {
            **BROWSER_HEADERS,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": "https://connect.ubisoft.com",
            "Referer": f"{UBISOFT_XBOX_CALLBACK}?code={code}",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "TE": "trailers",
        }

        ubi_cookies = {
            "UBI_PRIVACY_AA_OPTOUT": "false",
            "UBI_PRIVACY_ADS_OPTOUT": "false",
            "UBI_PRIVACY_CUSTOMIZATION_OPTOUT": "false",
            "UBI_PRIVACY_VIDEO_OPTOUT": "false",
            "UBI_PRIVACY_POLICY_ACCEPTED": "true",
            "UBI_PRIVACY_POLICY_VIEWED": "true",
            "UBI_PRIVACY_US_CMP": "true",
        }
        for name, value in ubi_cookies.items():
            self.session.cookies.set(name, value, domain="connect.ubisoft.com")

        payload = {"code": code}

        resp = self.session.post(UBISOFT_TOKEN_URL, json=payload, headers=headers)

        print(f"[ubi] Status: {resp.status_code}")

        if resp.status_code == 200:
            try:
                data = resp.json()
                print(f"[ubi] ✓ Token obtained!")
                print(f"[ubi]   idOnPlatform: {data.get('idOnPlatform')}")
                print(f"[ubi]   username: {data.get('username')}")
                print(f"[ubi]   externalId: {data.get('externalId')}")
                print(f"[ubi]   accessToken: ...{str(data.get('accessToken', ''))[-30:]}")
                return data
            except json.JSONDecodeError:
                print(f"[ubi] Response is not JSON: {resp.text[:200]}")
                return None
        elif resp.status_code == 403:
            print(f"[ubi] 403 - DataDome block or invalid cookies")
            print(f"[ubi] Response: {resp.text[:300]}")
            return None
        else:
            print(f"[ubi] Error: {resp.status_code}")
            print(f"[ubi] Response: {resp.text[:300]}")
            return None
