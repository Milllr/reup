"""Calls to the hub from the Pi. Standard library only. Never raises: the node keeps working when the hub is gone."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Optional

from .outbox import DROP, OK, RETRY

# Cloudflare turns away Python's own User-Agent (403, error 1010) before the hub ever sees the call.
USER_AGENT = "reup-node/1"


# What the laptop's relay answers when the hub did not answer the laptop. Then the hub is asked directly.
RELAY_FAILED = 502


class Hub:
    """The hub, reached two ways. relay is the laptop on the direct cable (the eye passes the calls on), url is the hub
    itself over the Pi's own internet. The relay is tried first: the Pi's own internet was a phone's hotspot that
    dropped for seconds at a time. When the relay does not answer it is left alone for skip_s and the hub is asked
    directly, so a laptop that is off costs one timeout, not one for every call."""

    def __init__(self, url: str, token: str, timeout: float = 2.5, opener=urllib.request.urlopen, relay: str = "", skip_s: float = 20.0, clock=None):
        import time  # noqa: PLC0415

        self.url = url.rstrip("/")
        self.relay = relay.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.opener = opener
        self.skip_s = skip_s
        self.clock = clock or time.monotonic
        self.relay_down_until = 0.0
        self.last_way = ""

    def _ways(self) -> list[str]:
        if self.relay and self.clock() >= self.relay_down_until:
            return [self.relay, self.url]
        return [self.url]

    def post(self, route: str, body: dict) -> tuple[str, Optional[dict]]:
        """ok with the answer, retry when the hub cannot be reached or is failing, drop when it refuses the body for good."""
        data = json.dumps(body).encode("utf-8")
        verdict: tuple[str, Optional[dict]] = (RETRY, None)
        for base in self._ways():
            request = urllib.request.Request(base + route, data=data, method="POST", headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
            try:
                with self.opener(request, timeout=self.timeout) as response:
                    self.last_way = base
                    return OK, json.loads(response.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as err:
                if base == self.relay and err.code == RELAY_FAILED:
                    self.relay_down_until = self.clock() + self.skip_s
                    continue
                self.last_way = base
                # 409 is a wrong state (an order already approved): nothing to send again. 401 means a wrong token: keep it and try again once fixed.
                return (DROP if err.code in (400, 404, 409, 422) else RETRY), None
            except (urllib.error.URLError, OSError, ValueError):
                if base == self.relay:
                    self.relay_down_until = self.clock() + self.skip_s
                continue
        return verdict
