"""The demo path, stage by stage, in the order a prospect meets it.

A stage with a `run` is built and is driven against the real environment on
every run. A stage without one names what is not built yet; it is reported
`pending` in every run, so the run's verdict is never read as the whole path.
Building a stage is giving its entry a `run` and adding its sabotage to
sabotage.py: the registry test fails until both are done.
"""

from __future__ import annotations

from .edge import COOKIE_NAME, Edge, login
from .runner import Checks, StageDef

# Paths a stranger with no cookie must be refused on, the admin area and its
# API included: the gate answers before Ghost does.
REFUSED_WITHOUT_COOKIE = ("/", "/ghost/", "/ghost/api/admin/", "/ghost/api/admin/settings/", "/rss/")


def gated_read(edge: Edge, checks: Checks) -> None:
    """A stranger is refused, a wrong passphrase gets nothing, the right one reads the slot."""
    for path in REFUSED_WITHOUT_COOKIE:
        reply = edge.request("GET", path)
        checks.equal(f"GET {path} with no cookie", 401, reply.status)
        checks.true(f"GET {path} with no cookie shows none of the site", "colour-" not in reply.body)

    wrong = login(edge, "not-the-passphrase")
    checks.equal("a wrong passphrase", 401, wrong.status)
    checks.equal("a cookie set on a wrong passphrase", "", wrong.cookie())

    right = login(edge, edge.passphrase)
    checks.equal("the right passphrase", 303, right.status)
    line = right.set_cookie_line()
    checks.true("the gate set its cookie", line.startswith(COOKIE_NAME + "="))
    for attribute in ("HttpOnly", "Secure", "SameSite=Lax", "Path=/"):
        checks.true(f"the cookie carries {attribute}", f"; {attribute}" in line)
    checks.true("the cookie is host-only", "domain=" not in line.lower())
    checks.true("the cookie names the slot's current lease", f".{edge.lease}." in line)

    cookie = right.cookie()
    home = edge.request("GET", "/", cookie=cookie)
    checks.equal("GET / with the cookie", 200, home.status)
    checks.true("the slot's own body is read", home.body.startswith("colour-"))
    for path in ("/ghost/", "/ghost/api/admin/"):
        checks.equal(f"GET {path} with the cookie", 200, edge.request("GET", path, cookie=cookie).status)


def recycle(edge: Edge, checks: Checks) -> None:
    """The next tenancy gets the slot; the previous one's cookie and passphrase open nothing."""
    previous = login(edge, edge.passphrase)
    checks.equal("the outgoing tenancy's login", 303, previous.status)
    old_cookie = previous.cookie()
    checks.equal(
        "the outgoing tenancy reads the slot",
        200,
        edge.request("GET", "/", cookie=old_cookie).status,
    )
    old_passphrase = edge.passphrase

    handed = edge.recycle()
    checks.true("the slot has a new passphrase", handed.passphrase != old_passphrase)

    checks.equal(
        "the outgoing cookie after the recycle",
        401,
        edge.request("GET", "/", cookie=old_cookie).status,
    )
    again = login(edge, old_passphrase)
    checks.equal("the outgoing passphrase after the recycle", 401, again.status)
    checks.equal("a cookie set to the outgoing passphrase", "", again.cookie())

    arrived = login(edge, handed.passphrase)
    checks.equal("the incoming tenancy's login", 303, arrived.status)
    checks.true(
        "the incoming cookie names the new lease",
        f".{handed.lease}." in arrived.set_cookie_line(),
    )
    checks.equal(
        "the incoming tenancy reads the slot",
        200,
        edge.request("GET", "/", cookie=arrived.cookie()).status,
    )


STAGES: tuple[StageDef[Edge], ...] = (
    StageDef("landing", "The landing page a stranger starts from", None, "no landing page serves the path yet"),
    StageDef("front-door", "The form a stranger fills in", None, "no form takes a stranger's details yet"),
    StageDef(
        "provisioning",
        "A slot is claimed and made, the stranger watching",
        None,
        "the lifecycle worker that runs a claim to a live slot is not built",
    ),
    StageDef(
        "arrival",
        "The single-use link becomes a gate session",
        None,
        "no single-use arrival link exists yet",
    ),
    StageDef(
        "admin-sign-in",
        "The owner signs into Ghost admin on their own demo",
        None,
        "needs the arrival link and a real Ghost behind the gate",
    ),
    StageDef("gated-read", "A passphrase opens the gated Ghost", gated_read),
    StageDef(
        "extension",
        "The extension request and its consent",
        None,
        "no extension request exists yet",
    ),
    StageDef("expiry", "The term ends on a shortened clock", None, "no reaper drives expiry yet"),
    StageDef("recycle", "The slot passes to the next tenancy", recycle),
)

# Where the path stops being a prospect's: the stages that are built must stay
# in this order, because a later one is only run when every earlier one held.
LIVE_IDS: tuple[str, ...] = tuple(s.stage_id for s in STAGES if s.run is not None)
