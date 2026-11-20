"""A visitor's HTTPS request through the edge, with the edge's own local root trusted and verification on."""

from __future__ import annotations

import http.client
import socket
import ssl
import urllib.parse
from collections.abc import Mapping
from pathlib import Path

from .edge import Reply


class _EdgeConnection(http.client.HTTPSConnection):
    """Connects to the published port but names the demo's hostname, for the handshake and the certificate check."""

    def __init__(self, hostname: str, address: str, port: int, context: ssl.SSLContext) -> None:
        super().__init__(hostname, port=port, context=context, timeout=15)
        self._address = address
        self._tls = context

    def connect(self) -> None:
        raw = socket.create_connection((self._address, self.port), timeout=15)
        self.sock = self._tls.wrap_socket(raw, server_hostname=self.host)


class Visitor:
    def __init__(self, hostname: str, port: int, ca_file: Path, address: str = "127.0.0.1") -> None:
        self._hostname = hostname
        self._port = port
        self._address = address
        # Certificate checks are never switched off: with no root to trust there is nothing to connect to.
        self._context = ssl.create_default_context(cafile=str(ca_file))

    def request(
        self,
        method: str,
        path: str,
        *,
        cookie: str = "",
        form: Mapping[str, str] | None = None,
    ) -> Reply:
        headers: dict[str, str] = {}
        body: bytes | None = None
        if cookie:
            headers["Cookie"] = cookie
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        connection = _EdgeConnection(self._hostname, self._address, self._port, self._context)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            collected: dict[str, list[str]] = {}
            for name, value in response.getheaders():
                collected.setdefault(name.lower(), []).append(value)
            text = response.read().decode("utf-8", errors="replace")
            return Reply(response.status, {k: tuple(v) for k, v in collected.items()}, text)
        finally:
            connection.close()
