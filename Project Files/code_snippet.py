import re
import json
import base64
import random
import aiohttp
import asyncio
import requests
import threading


class Ubisoft_Api:
    def __init__(self, login, proxy=None):
        self.proxy = proxy
        self.email, self.password = login.split(":", 1)
        self.base_url = "https://public-ubiservices.ubi.com"
        self.token = None
        self.session_id = None
        self.profile_id = None
        self.user_id = None
        
        self.base_headers = {
            "Ubi-AppId": "2c2d31af-4ee4-4049-85dc-00dc74aef88f",
            "User-Agent": "UbiServices_SDK_2020.Release.58_PC64_ansi_static",

            "Accept": "application/json",
            "Content-Type": "application/json",
            "Ubi-RequestedPlatformType": "uplay",
            "Ubi-LocaleCode": "en-US",

        }
        
    
    async def make_request(self, endpoint, method="GET", headers=None, params=None, data=None, json_data=None):
        try:
            url = f"{self.base_url}{endpoint}"
            headers = self.get_auth_headers() if not headers else headers
            request_kwargs = {"headers": headers}
            
            # Only include params if they are provided
            if params is not None:
                request_kwargs["params"] = params
            if data is not None:
                request_kwargs["data"] = data
            elif json_data is not None:
                request_kwargs["json"] = json_data
            
            # Include proxy if provided
            if self.proxy is not None:
                request_kwargs["proxy"] = f"http://{self.proxy}"

            async with aiohttp.ClientSession() as session:
                async with session.request(method, url, **request_kwargs) as response:
                    print(response)
                    print(await response.json())
                    if response.status != 200:
                        return (False, response.status)
                    
                    response_data = await response.json()
                    return response_data
        except Exception as e:
            print(e)
            return None
    
    # Ubisoft Authentication (Takes Login Details and gets valid Ubisoft account ticket)
    # ----------------------------------------------------------------------------
    async def authenticate(self):
        try:
            credentials = f"{self.email}:{self.password}"
            encoded_credentials = base64.b64encode(credentials.encode()).decode()
            
            auth_headers = self.base_headers.copy()
            auth_headers["Authorization"] = f"Basic {encoded_credentials}"

            login_request = await self.make_request(
                endpoint="/v3/profiles/sessions",
                method="POST",
                headers=auth_headers,
                json_data={"rememberMe": True},
            )

            try:
                if not login_request[0]:
                    # Invalid Account
                    if login_request[1] == 401:
                        return False, "INVALID"

                    # Rate limit
                    if login_request[1] == 429:
                        return False, "RATE_LIMIT"
            except:
                auth_data = login_request
            
            self.token = auth_data.get('ticket')
            self.session_id = auth_data.get('sessionId')
            self.profile_id = auth_data.get('profileId')
            self.user_id = auth_data.get('userId')
            
            return True, auth_data
        except Exception as e:
            return False, None
    # ----------------------------------------------------------------------------

    # Ubisoft Authentication Refresh (Takes an already valid about to expire ticket, then resets the expiration timer)
    # ----------------------------------------------------------------------------

    async def refresh_token(self, ticket_data):
        try:
            auth_headers = self.base_headers.copy()
            auth_headers["Authorization"] = f"ubi_v1 t={ticket_data['ticket']}"

            login_request = await self.make_request(
                endpoint="/v3/profiles/sessions",
                method="POST",
                headers=auth_headers,
                json_data={"rememberMe": False},
            )

            try:
                if not login_request[0]:
                    # Invalid Account
                    if login_request[1] == 401:
                        return False, "INVALID"

                    # Rate limit
                    if login_request[1] == 429:
                        return False, "RATE_LIMIT"
            except:
                # This is here to filter out attempts that result in the API marking the requests as being unauthorized or being rate limited.
                auth_data = login_request
            
            # These set all of the classes's variables to the new account token's details, as these change with every refresh or ticket login.
            self.token = auth_data.get('ticket')
            self.session_id = auth_data.get('sessionId')
            self.profile_id = auth_data.get('profileId')
            self.user_id = auth_data.get('userId')
            
            return True, auth_data
        except Exception as e:
            return False, None

    def get_auth_headers(self):
        headers = self.base_headers.copy()
        if self.token:
            headers["Authorization"] = f"Ubi_v1 t={self.token}"
        if self.session_id:
            headers["Ubi-SessionId"] = self.session_id
        return headers
    # ----------------------------------------------------------------------------

"""
Usage details, I've attached some accounts in their .csv file formatted form outputted from the linker tools.

API = Ubisoft_Api("account_email:account_password", proxy="uorder40522_country-US:KD1syXKaSXTQJGDn@budget.legionproxy.io:1337")
asyncio.run(API.refresh_token())
asyncio.run(API.authenticate())

"""