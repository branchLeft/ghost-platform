"""An in-memory edge that keeps the gate's contract, with the faults the real sabotage makes."""

from __future__ import annotations

from collections.abc import Mapping

from demo_path_e2e.edge import COOKIE_NAME, Recycled, Reply


class FakeEdge:
    def __init__(
        self,
        *,
        wrong_hash: bool = False,
        exempt_ghost: bool = False,
        keep_hash_on_recycle: bool = False,
    ) -> None:
        self._issued = "first-passphrase"
        self._lease = "LEASE-1"
        self._on_file = "some-other-passphrase" if wrong_hash else self._issued
        self._exempt_ghost = exempt_ghost
        self._keep_hash = keep_hash_on_recycle
        self._generation = 1

    @property
    def passphrase(self) -> str:
        return self._issued

    @property
    def lease(self) -> str:
        return self._lease

    def recycle(self) -> Recycled:
        self._generation += 1
        self._issued = f"passphrase-{self._generation}"
        self._lease = f"LEASE-{self._generation}"
        if not self._keep_hash:
            self._on_file = self._issued
        return Recycled(self._issued, self._lease)

    def request(
        self,
        method: str,
        path: str,
        *,
        cookie: str = "",
        form: Mapping[str, str] | None = None,
    ) -> Reply:
        if method == "POST" and path == "/__gate/login":
            if form is not None and form.get("passphrase") == self._on_file:
                line = (
                    f"{COOKIE_NAME}=v1.0.{self._lease}.mac; Path=/; Max-Age=60; "
                    "HttpOnly; Secure; SameSite=Lax"
                )
                return Reply(303, {"set-cookie": (line,)}, "")
            return Reply(401, {}, "")
        if self._exempt_ghost and path.startswith("/ghost/"):
            return Reply(200, {}, f"colour-a {method} {path}")
        if cookie.startswith(f"{COOKIE_NAME}=v1.0.{self._lease}."):
            return Reply(200, {}, f"colour-a {method} {path}")
        return Reply(401, {}, "")
