"""Start pymobiledevice3's Web Inspector CDP bridge on a Unix socket instead of a TCP port.

pymobiledevice3's `webinspector cdp` serves on 127.0.0.1:<port> with no authentication, so any
local user, or a web page open on the Mac, could connect and drive the iPhone tab. This wrapper
makes uvicorn listen on a Unix socket inside ios.mjs's owner-only state directory
(~/.cache/iphone-webkit-inspector, mode 700) instead, so only this user can reach it and
browsers can't reach it at all. As a second layer it refuses any request carrying an Origin header.
No secret is involved.

Usage: python bridge_guard.py <socket path> webinspector cdp [--native]
(everything after the socket path is pymobiledevice3's own CLI arguments)
"""

import sys

import uvicorn
from pymobiledevice3.services.web_protocol import cdp_server

SOCKET = sys.argv.pop(1)


class NoBrowserGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and b"origin" in dict(scope.get("headers") or []):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"forbidden"})
            return
        await self.app(scope, receive, send)


cdp_server.app.add_middleware(NoBrowserGuard)

# The cdp command builds uvicorn.Config(app, host=..., port=...); serve on the socket instead.
_Config = uvicorn.Config


def _unix_config(app, *args, **kwargs):
    kwargs.pop("host", None)
    kwargs.pop("port", None)
    return _Config(app, *args, uds=SOCKET, **kwargs)


uvicorn.Config = _unix_config

from pymobiledevice3.__main__ import main  # noqa: E402  (import after the patches are installed)

sys.argv = ["pymobiledevice3", *sys.argv[1:]]
main()
