"""Start pymobiledevice3's Web Inspector CDP bridge with a guard in front of it.

The bridge listens on 127.0.0.1 without any authentication of its own. Without this guard, a web
page open on the Mac (browsers let pages open WebSockets to localhost) or another user on the same
Mac could connect to ws://127.0.0.1:<port>/devtools/page/<id> and drive the user's iPhone tab.

Every HTTP and WebSocket request must:
- carry the per-run secret as ?iwi=<secret>. ios.mjs generates it and passes it in the
  IWI_BRIDGE_SECRET environment variable, so it is never written to disk;
- carry no Origin header (browsers always send one for cross-site fetches and WebSockets);
- use Host 127.0.0.1 or localhost (blocks DNS rebinding).
Everything else gets 403. Requests that pass go through unchanged.

Usage: IWI_BRIDGE_SECRET=... python bridge_guard.py webinspector cdp --port 9333 [--native]
(the arguments are pymobiledevice3's own CLI arguments)
"""

import hmac
import os
import sys
from urllib.parse import parse_qs

from pymobiledevice3.services.web_protocol import cdp_server

ALLOWED_HOSTS = (b"127.0.0.1", b"localhost")
SECRET = os.environ.pop("IWI_BRIDGE_SECRET", "")
if len(SECRET) < 32:
    sys.exit("bridge_guard: IWI_BRIDGE_SECRET is missing; start the bridge through ios.mjs")


class LocalOnlyGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope.get("headers") or [])
            host = headers.get(b"host", b"").rsplit(b":", 1)[0]
            given = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("iwi", [""])[0]
            if b"origin" in headers or host not in ALLOWED_HOSTS or not hmac.compare_digest(given, SECRET):
                if scope["type"] == "websocket":
                    # Closing before accept makes the server answer the handshake with 403.
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": b"forbidden"})
                return
        await self.app(scope, receive, send)


cdp_server.app.add_middleware(LocalOnlyGuard)

from pymobiledevice3.__main__ import main  # noqa: E402  (import after the guard is installed)

sys.argv = ["pymobiledevice3", *sys.argv[1:]]
main()
