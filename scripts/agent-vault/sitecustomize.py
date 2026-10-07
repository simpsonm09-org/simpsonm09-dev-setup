import os
from urllib.parse import urlparse

try:
    import aiohttp
    import discord.http as dh
except ImportError:
    aiohttp = None
    dh = None

if dh is not None and getattr(dh, "HTTPClient", None) is not None:
    _orig = dh.HTTPClient.__init__

    def _init(self, *args, **kwargs):
        if not kwargs.get("proxy"):
            proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
            if proxy:
                parsed = urlparse(proxy)
                if parsed.hostname:
                    kwargs["proxy"] = (
                        f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                    )
                    if parsed.username:
                        kwargs["proxy_auth"] = aiohttp.BasicAuth(
                            parsed.username, parsed.password or ""
                        )
        _orig(self, *args, **kwargs)

    dh.HTTPClient.__init__ = _init
