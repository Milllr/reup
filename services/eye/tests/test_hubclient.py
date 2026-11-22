import io
import json
import urllib.error

from reup_eye.hubclient import Hub


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_calls_carry_the_token_and_a_user_agent_cloudflare_lets_through():
    seen = []

    def opener(request, timeout):
        seen.append(request)
        return Answer(json.dumps({"ok": True, "zones": []}).encode())

    hub = Hub("https://hub.example/", "device-1", opener=opener)
    assert hub.state() == {"ok": True, "zones": []}
    assert hub.counts([{"zoneId": "z-glue", "count": 3}], [{"id": "board", "online": True}])
    assert hub.cancel_teach("t-7")
    get, post, cancel = seen
    assert (cancel.full_url, cancel.get_method(), cancel.data) == ("https://hub.example/api/teach/t-7/cancel", "POST", None)
    assert (get.full_url, get.get_method()) == ("https://hub.example/api/state", "GET")
    assert json.loads(post.data) == {"counts": [{"zoneId": "z-glue", "count": 3}], "cameras": [{"id": "board", "online": True}]}
    for request in seen:
        # Python's default (Python-urllib/3.x) is answered 403 with error 1010 on workers.dev.
        assert request.get_header("User-agent") == "reup-eye/1"
        assert request.get_header("Authorization") == "Bearer device-1"


def test_a_refusal_never_raises_and_is_kept_as_the_last_error():
    def opener(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(b"error code: 1010"))

    hub = Hub("https://hub.example", "t", opener=opener)
    assert hub.state() is None and "403 error code: 1010" in hub.last_error
