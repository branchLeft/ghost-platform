#!/usr/bin/env python3
"""Create one test payment and one recurring schedule in Mollie's TEST mode.

Usage:
    MOLLIE_API_KEY_TEST=test_... mollie-test-charge.py

Exit 0 if every step succeeded and every response said mode "test".
Exit 1 if a step failed. Exit 2 if the key was refused before any network call.
See scripts/mollie-test-charge.md.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import TextIO

API_BASE = "https://api.mollie.com/v2"
KEY_ENV = "MOLLIE_API_KEY_TEST"
TEST_KEY = re.compile(r"\Atest_[A-Za-z0-9]{8,}\Z")
TIMEOUT_SECONDS = 30

EXIT_OK = 0
EXIT_STEP_FAILED = 1
EXIT_REFUSED = 2

# SEPA direct debit is the one mandate the API can create without a customer
# at a checkout, and it is euro only; the schedule shares its currency.
CURRENCY = "EUR"
AMOUNT = "1.00"
PLACEHOLDER_NAME = "TEST_CUSTOMER_PLACEHOLDER"
PLACEHOLDER_EMAIL = "test-customer@example.com"
PAYMENT_DESCRIPTION = "TEST_CHARGE_PLACEHOLDER"
SCHEDULE_DESCRIPTION = "TEST_SCHEDULE_PLACEHOLDER"
REDIRECT_URL = "https://example.com/"
# An example IBAN shape from Mollie's own reference, not an account.
EXAMPLE_IBAN = "NL55INGB0000000000"

# (method, url, headers, body) -> (http status, response body)
Transport = Callable[[str, str, Mapping[str, str], "bytes | None"], "tuple[int, bytes]"]


class Refused(Exception):
    pass


class StepFailed(Exception):
    pass


def check_key(raw: str | None) -> str:
    """Return the key if it is a Mollie test key, else raise Refused.

    The message never repeats the value: a refused live key must not be echoed.
    """
    key = (raw or "").strip()
    if not key:
        raise Refused(f"{KEY_ENV} is empty or unset")
    if not TEST_KEY.match(key):
        raise Refused(f"{KEY_ENV} is not a Mollie test key (it must start with test_)")
    return key


def urllib_transport(method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


class Client:
    def __init__(self, key: str, transport: Transport) -> None:
        self._key = key
        self._transport = transport

    def redact(self, text: str) -> str:
        return text.replace(self._key, "***")

    def post(self, step: str, path: str, payload: dict, id_prefix: str) -> dict:
        headers = {
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        try:
            status, raw = self._transport("POST", API_BASE + path, headers, json.dumps(payload).encode())
        except Exception as err:  # noqa: BLE001 - any transport fault is a failed step
            raise StepFailed(self.redact(f"{step}: request failed ({type(err).__name__})")) from None
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise StepFailed(f"{step}: HTTP {status} with a body that is not a JSON object")
        if not 200 <= status < 300:
            title = data.get("title")
            suffix = f" ({self.redact(title)})" if isinstance(title, str) else ""
            raise StepFailed(f"{step}: HTTP {status}{suffix}")
        if data.get("mode") != "test":
            raise StepFailed(f"{step}: response mode is not test")
        ident = data.get("id")
        if not isinstance(ident, str) or not ident.startswith(id_prefix):
            raise StepFailed(f"{step}: response has no {id_prefix} id")
        status_text = data.get("status")
        if not isinstance(status_text, str):
            raise StepFailed(f"{step}: response has no status")
        return data


def report(out: TextIO, label: str, data: dict) -> None:
    out.write(f"{label} id={data['id']} status={data['status']} mode={data['mode']}\n")


def run(client: Client, out: TextIO) -> None:
    amount = {"currency": CURRENCY, "value": AMOUNT}
    payment = client.post(
        "payment",
        "/payments",
        {"amount": amount, "description": PAYMENT_DESCRIPTION, "redirectUrl": REDIRECT_URL},
        "tr_",
    )
    report(out, "payment", payment)
    customer = client.post("customer", "/customers", {"name": PLACEHOLDER_NAME, "email": PLACEHOLDER_EMAIL}, "cst_")
    out.write(f"customer id={customer['id']} mode={customer['mode']}\n")
    mandate = client.post(
        "mandate",
        f"/customers/{customer['id']}/mandates",
        {"method": "directdebit", "consumerName": PLACEHOLDER_NAME, "consumerAccount": EXAMPLE_IBAN},
        "mdt_",
    )
    report(out, "mandate", mandate)
    schedule = client.post(
        "schedule",
        f"/customers/{customer['id']}/subscriptions",
        {"amount": amount, "interval": "1 month", "times": 1, "description": SCHEDULE_DESCRIPTION},
        "sub_",
    )
    report(out, "schedule", schedule)


def main(
    env: Mapping[str, str] | None = None,
    transport: Transport = urllib_transport,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    env = os.environ if env is None else env
    out = sys.stdout if out is None else out
    err = sys.stderr if err is None else err
    try:
        key = check_key(env.get(KEY_ENV))
    except Refused as refusal:
        err.write(f"refused: {refusal}\n")
        return EXIT_REFUSED
    client = Client(key, transport)
    try:
        run(client, out)
    except StepFailed as failure:
        err.write(f"failed: {failure}\n")
        return EXIT_STEP_FAILED
    out.write("ok: test charge and recurring schedule created in test mode\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
