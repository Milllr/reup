"""Calls to the hub from the Pi. Standard library only. Never raises: the node keeps working when the hub is gone."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Optional

from .outbox import DROP, OK, RETRY

# Cloudflare turns away Python's own User-Agent (403, error 1010) before the hub ever sees the call.
USER_AGENT = "reup-node/1"


class Hub:
    def __init__(self, url: str, token: str, timeout: float = 2.5, opener=urllib.request.urlopen):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.opener = opener

    def post(self, route: str, body: dict) -> tuple[str, Optional[dict]]:
        """ok with the answer, retry when the hub cannot be reached or is failing, drop when it refuses the body for good."""
        request = urllib.request.Request(self.url + route, data=json.dumps(body).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
        try:
            with self.opener(request, timeout=self.timeout) as response:
                return OK, json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as err:
            # 409 is a wrong state (an order already approved): nothing to send again. 401 means a wrong token: keep it and try again once fixed.
            return (DROP if err.code in (400, 404, 409, 422) else RETRY), None
        except (urllib.error.URLError, OSError, ValueError):
            return RETRY, None
