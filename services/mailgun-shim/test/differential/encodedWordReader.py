"""Reads composed messages the way a recipient's mail software might.

Standard library only. Input on stdin: a JSON list of base64-encoded raw
messages. Output on stdout: a JSON list with, for each message, the domains
that three Python readers find in its From header (lower case, no trailing
dot; an empty string where an address has no domain; null where the reader
raised).
"""

import base64
import json
import sys
from email import message_from_bytes, policy, utils


def domain_of(address):
    return address.rpartition("@")[2].lower().rstrip(".") if "@" in address else ""


def read_default(raw):
    header = message_from_bytes(raw, policy=policy.default)["From"]
    if header is None:
        return []
    return [(a.domain or "").lower().rstrip(".") for a in header.addresses]


def read_getaddresses(raw):
    value = message_from_bytes(raw)["From"]
    if value is None:
        return []
    return [domain_of(address) for _, address in utils.getaddresses([str(value)])]


def read_parseaddr(raw):
    value = message_from_bytes(raw)["From"]
    if value is None:
        return []
    return [domain_of(utils.parseaddr(str(value))[1])]


def safe(reader, raw):
    try:
        return reader(raw)
    except Exception:
        return None


def main():
    encoded = json.load(sys.stdin)
    results = []
    for item in encoded:
        raw = base64.b64decode(item)
        results.append(
            {
                "default": safe(read_default, raw),
                "getaddresses": safe(read_getaddresses, raw),
                "parseaddr": safe(read_parseaddr, raw),
            }
        )
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
