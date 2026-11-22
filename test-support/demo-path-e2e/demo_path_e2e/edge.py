"""What a stage may do to the environment: look at the demo as a visitor, and recycle its slot.

The stages know only this interface. The real environment (environment.py)
answers it with a rendered demo edge, the gate and stand-in colours; the unit
tests answer it in memory, so a stage's checks are shown able to fail without
Docker.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

COOKIE_NAME = "__Host-bl_demo_gate"


@dataclass(frozen=True)
class Reply:
    status: int
    # Header names are lower case; a header sent twice has both values.
    headers: Mapping[str, tuple[str, ...]]
    body: str

    def cookie(self) -> str:
        """The gate's cookie as a request would send it back (`name=value`), or empty."""
        for value in self.headers.get("set-cookie", ()):
            pair = value.split(";", 1)[0]
            if pair.startswith(COOKIE_NAME + "="):
                return pair
        return ""

    def set_cookie_line(self) -> str:
        for value in self.headers.get("set-cookie", ()):
            if value.startswith(COOKIE_NAME + "="):
                return value
        return ""


@dataclass(frozen=True)
class Recycled:
    """The new tenancy of the slot, as the broker hands it over on a recycle."""

    passphrase: str
    lease: str


class Edge(Protocol):
    @property
    def passphrase(self) -> str:
        """The passphrase the slot's current tenancy was issued."""
        ...

    @property
    def lease(self) -> str:
        """The lease the slot's current tenancy holds."""
        ...

    def request(
        self,
        method: str,
        path: str,
        *,
        cookie: str = "",
        form: Mapping[str, str] | None = None,
    ) -> Reply:
        """One request to the demo's own hostname through the edge, from a visitor."""
        ...

    def recycle(self) -> Recycled:
        """Hand the slot to its next tenancy: a new passphrase and a new lease."""
        ...


def login(edge: Edge, passphrase: str, landing: str = "/ghost/") -> Reply:
    """The passphrase form's post, as a visitor's browser sends it."""
    return edge.request("POST", "/__gate/login", form={"passphrase": passphrase, "r": landing})
