"""Start pymobiledevice3's Web Inspector CDP bridge with a guard in front of it.

The bridge listens on 127.0.0.1 without any authentication, and browsers let any web page open a
WebSocket to localhost. Without this guard, a page open on the Mac could connect to
ws://127.0.0.1:<port>/devtools/page/<id> and drive the user's iPhone tab.

The guard rejects every request that carries an Origin header (browsers always send one for
cross-site fetches and WebSockets; ios.mjs's Node client sends none) and every request whose Host
isn't 127.0.0.1 or localhost (DNS rebinding). Everything else is passed through unchanged.

Usage: python bridge_guard.py webinspector cdp --port 9333 [--native]
(the arguments are pymobiledevice3's own CLI arguments)
"""

import sys

from pymobiledevice3.services.web_protocol import cdp_server

ALLOWED_HOSTS = (b"127.0.0.1", b"localhost")


class LocalOnlyGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope.get("headers") or [])
            host = headers.get(b"host", b"").rsplit(b":", 1)[0]
            if b"origin" in headers or host not in ALLOWED_HOSTS:
                if scope["type"] == "websocket":
                    # Closing before accept makes the server answer the handshake with 403.
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": b"forbidden: local clients only"})
                return
        await self.app(scope, receive, send)


cdp_server.app.add_middleware(LocalOnlyGuard)

from pymobiledevice3.__main__ import main  # noqa: E402  (import after the guard is installed)

sys.argv = ["pymobiledevice3", *sys.argv[1:]]
main()
