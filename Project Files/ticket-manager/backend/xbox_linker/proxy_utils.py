import requests

def parse_proxy(proxy_str: str) -> dict:
    
    if not proxy_str:
        return {}

    proxy_str = proxy_str.strip()

    if "@" in proxy_str:
        creds, hostport = proxy_str.rsplit("@", 1)
        proxy_url = f"http://{creds}@{hostport}"
    else:
        proxy_url = f"http://{proxy_str}"

    return {
        "http": proxy_url,
        "https": proxy_url,
    }

def create_session(proxy_str: str = None, headers: dict = None) -> requests.Session:
    
    session = requests.Session()

    if headers:
        session.headers.update(headers)

    if proxy_str:
        session.proxies = parse_proxy(proxy_str)
        host = proxy_str.split("@")[-1] if "@" in proxy_str else proxy_str
        print(f"[proxy] Using proxy: {host}")

    return session
