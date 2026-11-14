"""The real Stripe TEST-mode switch for the checkout gate.

Every refusal that stands between an owner's shell and a Ghost holding a Stripe
key lives here, in one module the gate runner calls in process. The default gate
never reads any of it. What the switch lets through, and what it does not prove:
csp/gate/csp-checkout-gate.md.

A refusal names the variable and the rule, never the value. Nothing in this file
prints, logs or returns a key.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

SWITCH = "CSP_STRIPE_REAL_TEST_MODE"
CARD_ENV = "CSP_STRIPE_TEST_CARD"
WEBHOOK_PATH = "/members/webhooks/stripe/"
# Stripe's published success test card. Nothing else is ever typed.
PUBLISHED_TEST_CARD = "4242 4242 4242 4242"
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1"})
DEFAULT_PORT = "4321"
REDACTED = "[REDACTED]"
MIN_SECRET_LENGTH = 8


class Refusal(Exception):
    """A rule of the switch said no. The message names the rule, never a value."""


class AmbiguousOrigin(ValueError):
    """The URL carries userinfo, which another parser may read as a different host."""


@dataclass(frozen=True)
class KeyRule:
    name: str
    pattern: re.Pattern[str]
    shape: str


@dataclass(frozen=True)
class KeyProblem:
    name: str
    problem: str


@dataclass(frozen=True)
class LocalTenant:
    origin: str
    port: str


@dataclass(frozen=True)
class PreflightResult:
    ok: bool
    lines: tuple[str, ...]


# Environment only: never a file, never an argument. Matched with fullmatch, so a
# trailing newline or any stray character refuses.
KEY_RULES: tuple[KeyRule, ...] = (
    KeyRule(
        "STRIPE_TEST_SECRET_KEY",
        re.compile(r"sk_test_[A-Za-z0-9]+"),
        "sk_test_ followed by letters and digits",
    ),
    KeyRule(
        "STRIPE_TEST_PUBLISHABLE_KEY",
        re.compile(r"pk_test_[A-Za-z0-9]+"),
        "pk_test_ followed by letters and digits",
    ),
    KeyRule(
        "STRIPE_TEST_WEBHOOK_SECRET",
        re.compile(r"whsec_[A-Za-z0-9]+"),
        "whsec_ followed by letters and digits (from `stripe listen --print-secret`)",
    ),
)

# Names whose values must never reach any output.
SECRET_ENV_NAMES: tuple[str, ...] = (
    *(rule.name for rule in KEY_RULES),
    "PROOF_STRIPE_SECRET_KEY",
    "PROOF_STRIPE_PUBLISHABLE_KEY",
    "WEBHOOK_SECRET",
)

SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]+"),
    re.compile(r"whsec_[A-Za-z0-9]+"),
)
CHECKOUT_FRAGMENT = re.compile(r"(https://checkout\.stripe\.com/[^\s\"'#]*)#[^\s\"']*")


def classify(value: str) -> str | None:
    """Says what KIND of wrong value it is by its prefix, which is not secret; it
    never repeats any other part of the value."""
    if value.startswith("sk_live_"):
        return "a LIVE secret key is refused (test mode only)"
    if value.startswith("pk_live_"):
        return "a LIVE publishable key is refused (test mode only)"
    if value.startswith("rk_"):
        return "a restricted key is refused until a test proves it works with Ghost"
    return None


def key_problems(env: Mapping[str, str]) -> list[KeyProblem]:
    """What is wrong with the three keys in `env`; empty means every key is accepted."""
    problems: list[KeyProblem] = []
    for rule in KEY_RULES:
        value = env.get(rule.name, "")
        if value == "":
            problems.append(KeyProblem(rule.name, "is not set or is empty"))
        elif rule.pattern.fullmatch(value) is None:
            kind = classify(value) or "has the wrong shape"
            problems.append(KeyProblem(rule.name, f"{kind}; it must be {rule.shape}"))
    return problems


def _split_origin(origin: str) -> tuple[str, str, int | None]:
    """(scheme, host, port) of a URL, refusing what a second parser could read as another host.

    Raises:
        ValueError: the text is not a URL this module will read.
    """
    if any(c in origin for c in " \t\r\n") or not origin.isascii():
        raise ValueError(origin)
    parts = urlsplit(origin)
    if "@" in parts.netloc:
        raise AmbiguousOrigin(origin)
    return parts.scheme.lower(), (parts.hostname or "").lower(), parts.port


def assert_local_tenant(origin: str | None) -> LocalTenant:
    """The tenant under test must be the local disposable one.

    Raises:
        Refusal: it is not http://localhost:<port> or http://127.0.0.1:<port>.
    """
    not_local = Refusal(
        "refusing: real test mode only runs against the local disposable tenant "
        "(http://localhost:<port> or http://127.0.0.1:<port>)"
    )
    try:
        if origin is None:
            raise ValueError("no origin")
        scheme, host, port = _split_origin(origin)
    except AmbiguousOrigin:
        raise not_local from None
    except ValueError:
        raise Refusal(
            "refusing: the tenant origin is not a URL (it must be http://localhost:<port>)"
        ) from None
    if scheme != "http" or host not in LOCAL_HOSTS or port is None or port == 0:
        raise not_local
    return LocalTenant(origin=f"http://{host}:{port}", port=str(port))


def assert_published_test_card(card: object) -> str:
    """Only the published test card is ever typed. Never repeats the input.

    Raises:
        Refusal: the input is any other card number (or not text at all).
    """
    digits = re.sub(r"[\s-]", "", card) if isinstance(card, str) else ""
    if digits != PUBLISHED_TEST_CARD.replace(" ", ""):
        raise Refusal(
            f"refusing: only Stripe's published test card {PUBLISHED_TEST_CARD} is ever "
            "entered; any other card number is refused"
        )
    return PUBLISHED_TEST_CARD


def secret_values(env: Mapping[str, str]) -> list[str]:
    """The values of every secret-bearing variable that is set and long enough to be one."""
    values = (env.get(name, "") for name in SECRET_ENV_NAMES)
    return [value for value in values if len(value) >= MIN_SECRET_LENGTH]


def redact_secrets(text: str, secrets: Sequence[str] = ()) -> str:
    """Removes the exact values of the named secrets, key-shaped strings, and the
    fragment of a hosted-checkout URL (it carries the account's encoded key data).
    Applied to anything the node steps print."""
    out = text
    for secret in sorted(secrets, key=len, reverse=True):
        if len(secret) >= MIN_SECRET_LENGTH:
            out = out.replace(secret, REDACTED)
    for pattern in SECRET_PATTERNS:
        out = pattern.sub(REDACTED, out)
    return CHECKOUT_FRAGMENT.sub(rf"\1#{REDACTED}", out)


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _document_origin(uri: str) -> tuple[str, str, int] | None:
    """(scheme, host, port) of an http(s) document; None for anything else."""
    scheme, host, port = _split_origin(uri)
    if scheme not in _DEFAULT_PORTS or host == "":
        return None
    return scheme, host, port if port is not None else _DEFAULT_PORTS[scheme]


def is_tenant_violation(violation: Mapping[str, object], tenant_origin: str) -> bool:
    """True when the violation was raised by a document of the tenant, which is
    what the tenant's policy governs. Stripe's hosted page and its own frames
    answer to Stripe's policy. A document that cannot be placed is counted as
    the tenant's (fail closed)."""
    document = violation.get("documentURI")
    if not isinstance(document, str):
        return True
    try:
        placed = _document_origin(document)
        tenant = _document_origin(tenant_origin)
    except ValueError:
        return True
    return placed is None or placed == tenant


def scrub_capture(text: str, tenant_origin: str, secrets: Sequence[str]) -> str:
    """The capture's JSON as the gate may use and print it: every secret redacted, and
    the violations Stripe's own pages raised (under Stripe's policy) split off into a
    `foreignViolations` count, so the judge counts the tenant's violations only."""
    redacted = redact_secrets(text, secrets)
    try:
        run = json.loads(redacted)
    except ValueError:
        return redacted
    if not isinstance(run, dict) or not isinstance(run.get("violations"), list):
        return redacted
    violations: list[object] = run["violations"]
    ours = [
        v for v in violations if not isinstance(v, dict) or is_tenant_violation(v, tenant_origin)
    ]
    run["violations"] = ours
    run["foreignViolations"] = len(violations) - len(ours)
    return json.dumps(run, indent=2)


def owner_command() -> str:
    """The one command block the owner runs, with every non-secret value filled."""
    return "\n".join(
        [
            "read -rs STRIPE_TEST_SECRET_KEY; export STRIPE_TEST_SECRET_KEY",
            "read -rs STRIPE_TEST_PUBLISHABLE_KEY; export STRIPE_TEST_PUBLISHABLE_KEY",
            "read -rs STRIPE_TEST_WEBHOOK_SECRET; export STRIPE_TEST_WEBHOOK_SECRET",
            f"{SWITCH}=1 csp/gate/csp-checkout-gate.py",
        ]
    )


def listen_command(port: str) -> str:
    return f"stripe listen --forward-to http://localhost:{port}{WEBHOOK_PATH}"


def usage(port: str = DEFAULT_PORT) -> str:
    return "\n".join(
        [
            f"Real Stripe TEST-mode checkout (opt in with {SWITCH}=1).",
            "",
            "Prerequisites: Docker running; render-core built (cd render-core && pnpm run build);",
            "Chromium installed (cd csp/proof && pnpm install && pnpm exec playwright install chromium);",
            "the Stripe CLI logged in to the TEST-mode account, with this running in a second terminal:",
            "",
            listen_command(port),
            "",
            "`stripe listen --print-secret` prints the signing secret (whsec_...) for STRIPE_TEST_WEBHOOK_SECRET.",
            "The keys come from the shell environment only (a restricted rk_ key is refused). Run from the",
            "repository root, in the first terminal:",
            "",
            owner_command(),
            "",
            f"Only the published test card {PUBLISHED_TEST_CARD} is entered, only against the local tenant.",
        ]
    )


def preflight(env: Mapping[str, str], origin: str) -> PreflightResult:
    """Everything checked before a container starts. `lines` is for the owner and
    carries no key value."""
    problems = [f"{p.name}: {p.problem}" for p in key_problems(env)]
    tenant: LocalTenant | None = None
    try:
        tenant = assert_local_tenant(origin)
    except Refusal as refusal:
        problems.append(str(refusal))
    if CARD_ENV in env:
        try:
            assert_published_test_card(env[CARD_ENV])
        except Refusal as refusal:
            problems.append(f"{CARD_ENV}: {refusal}")
    if problems or tenant is None:
        port = tenant.port if tenant else DEFAULT_PORT
        lines = ("REAL TEST MODE REFUSED:", *(f"  {p}" for p in problems), "", usage(port))
        return PreflightResult(False, lines)
    names = ", ".join(rule.name for rule in KEY_RULES)
    return PreflightResult(
        True,
        (
            f"real test mode: keys accepted (names only: {names}), tenant {tenant.origin}",
            f"webhook route, in a second terminal before the gate pays: {listen_command(tenant.port)}",
        ),
    )
