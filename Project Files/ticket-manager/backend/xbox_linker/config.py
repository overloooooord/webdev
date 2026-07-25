MICROSOFT_CLIENT_ID = "000000004893BB73"
XBOX_SCOPES = f"{MICROSOFT_CLIENT_ID}:XboxLive.signin"
UBISOFT_APP_CLIENT_ID = "a6ba5fe8-6197-4710-a0a4-5fe8905826e8"

MS_LOGIN_URL = "https://login.live.com"
MS_AUTHORIZE_URL = f"{MS_LOGIN_URL}/oauth20_authorize.srf"
MS_CONSENT_URL = "https://account.live.com/Consent/Update"
MS_ACCOUNT_URL = "https://account.live.com"

UBISOFT_TOKEN_URL = "https://connect.ubisoft.com/v2/externalparties/public/microsoft/xbox/oauth/token"
UBISOFT_XBOX_CALLBACK = "https://connect.ubisoft.com/xbox-callback"

# Xbox Profile
XBOX_USER_URL = "https://user.auth.xboxlive.com/user/authenticate"
XBOX_XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize"
XBOX_PROFILE_URL = "https://accounts.xboxlive.com/accounts/create"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"

BROWSER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Sec-GPC": "1",
}

IMAP_HOSTS = {
    # Real mailboxes that receive forwards from addy.to/addymail.com aliases
    "rambler.ru": ("imap.rambler.ru", 993, True),
    "lenta.ru":   ("imap.rambler.ru", 993, True),
    "autorambler.ru": ("imap.rambler.ru", 993, True),
    "myrambler.ru": ("imap.rambler.ru", 993, True),
    "ro.ru":      ("imap.rambler.ru", 993, True),
    "mail.ru":    ("imap.mail.ru", 993, True),
    "bk.ru":      ("imap.mail.ru", 993, True),
    "list.ru":    ("imap.mail.ru", 993, True),
    "inbox.ru":   ("imap.mail.ru", 993, True),
    # FirstMail domains
    "streetwormail.com": ("mail.streetwormail.com", 993, True),
    "vargosmail.com": ("imap.firstmail.ltd", 993, True),
    "firstmail.ltd": ("imap.firstmail.ltd", 993, True),
    "4wrd.cc": ("imap.firstmail.ltd", 993, True),
    "addymail.com": ("imap.firstmail.ltd", 993, True),
    # Other
    "notlettersmail.com": ("mail.notlettersmail.com", 143, False),
    "belettersmail.com": ("mail.belettersmail.com", 143, False),
    "onelettersmail.com": ("mail.onelettersmail.com", 143, False),
}
