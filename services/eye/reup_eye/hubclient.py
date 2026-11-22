"""The eye's calls to the hub. Standard library only, short timeouts, and a failure never raises: the eye keeps counting."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Optional

USER_AGENT = "reup-eye/1"


class Hub:
    def __init__(self, url: str, token: str, timeout: float = 3.0, opener=urllib.request.urlopen):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.opener = opener
        self.last_error: Optional[str] = None

    def _call(self, method: str, path: str, body: Optional[dict] = None) -> Optional[dict]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        # Cloudflare turns away Python's own User-Agent (403, error 1010) before the hub ever sees the call.
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": USER_AGENT}
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with self.opener(request, timeout=self.timeout) as response:
                self.last_error = None
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as err:
            self.last_error = f"{method} {path}: the hub answered {err.code} {err.read().decode('utf-8', 'replace')[:200]}"
        except (urllib.error.URLError, OSError, ValueError) as err:
            self.last_error = f"{method} {path}: {err}"
        return None

    def state(self) -> Optional[dict]:
        return self._call("GET", "/api/state")

    def counts(self, counts: list[dict], cameras: Optional[list[dict]] = None) -> bool:
        body: dict = {"counts": counts}
        if cameras is not None:
            body["cameras"] = cameras
        return self._call("POST", "/ingest/counts", body) is not None

    def teach(self, jpeg: bytes, zone_id: Optional[str]) -> Optional[dict]:
        return self._call("POST", "/api/teach", {"jpegBase64": base64.b64encode(jpeg).decode("ascii"), "zoneId": zone_id})

    def cancel_teach(self, teach_id: str) -> bool:
        """Takes the new part card down. False when the hub no longer has it, which is just as good."""
        return self._call("POST", f"/api/teach/{teach_id}/cancel") is not None
