#!/usr/bin/env python3
"""Scans the demo edge's access log for a passphrase that travelled in a URL.

A passphrase in a URL ends up in browser history, screenshots, pasted chat
messages and this log, whose retention is a tool default. The only way a
passphrase reaches the gate is the form's POST body, so a passphrase in any
logged URL means something put it there. Exit 0 only when the log was read,
was not empty and carries none.

Usage: scan_edge_access_log.py LOG [--passphrase-file FILE]

See scan_edge_access_log.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Iterable, Sequence
from urllib.parse import parse_qsl, unquote_plus, urlsplit

# Names a form or a person would give a passphrase in a query string.
PASSPHRASE_PARAMETER_NAMES = frozenset({"passphrase", "passphrases", "password", "passwd", "pwd", "pass"})

# A known passphrase shorter than this would match by accident, so it is not accepted.
MIN_KNOWN_LENGTH = 8

# What separates the words of a passphrase when it is typed, pasted or re-encoded.
_SEPARATORS = re.compile(r"[\s_+.\-]+")

EXIT_CLEAN, EXIT_FOUND, EXIT_UNREADABLE = 0, 1, 2


class UnreadableLog(Exception):
    """The log could not be scanned, so nothing can be said about it."""


def normalise(text: str) -> str:
    """Lower-cases and collapses separators, so `Correct_Horse+battery` meets `correct horse battery`."""
    return _SEPARATORS.sub(" ", unquote_plus(text).lower()).strip()


def read_known_passphrases(lines: Iterable[str]) -> list[str]:
    known = []
    for raw in lines:
        phrase = normalise(raw.rstrip("\r\n"))
        if not phrase:
            continue
        if len(phrase) < MIN_KNOWN_LENGTH:
            raise UnreadableLog("a known passphrase is too short to search for without false matches")
        known.append(phrase)
    return known


def _referers(request: dict) -> list[str]:
    headers = request.get("headers")
    if not isinstance(headers, dict):
        return []
    values = next((v for k, v in headers.items() if isinstance(k, str) and k.lower() == "referer"), [])
    return [v for v in values if isinstance(v, str)] if isinstance(values, list) else []


def _findings(url: str, known: Sequence[str]) -> list[str]:
    """Why `url` is red, as short reasons that never carry the passphrase."""
    reasons = []
    query = urlsplit(url).query
    names = {name.lower() for name, _ in parse_qsl(query, keep_blank_values=True)}
    if names & PASSPHRASE_PARAMETER_NAMES:
        reasons.append("a query parameter is named like a passphrase")
    haystack = normalise(url)
    if any(phrase in haystack for phrase in known):
        reasons.append("a known passphrase appears in the URL")
    return reasons


def scan(lines: Iterable[str], known: Sequence[str] = ()) -> tuple[int, list[tuple[int, str]]]:
    """Returns (entries read, [(line number, reason)]). Raises UnreadableLog on a line that is not an entry."""
    entries = 0
    found: list[tuple[int, str]] = []
    for number, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw)
        except ValueError as error:
            raise UnreadableLog(f"line {number} is not JSON") from error
        request = entry.get("request") if isinstance(entry, dict) else None
        if not isinstance(request, dict) or not isinstance(request.get("uri"), str):
            raise UnreadableLog(f"line {number} is not an access log entry")
        entries += 1
        urls = [request["uri"], *_referers(request)]
        for url in urls:
            found.extend((number, reason) for reason in _findings(url, known))
    return entries, found


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("log")
    parser.add_argument("--passphrase-file", help="known passphrases, one per line, to search for as well")
    args = parser.parse_args(argv)
    try:
        known: list[str] = []
        if args.passphrase_file:
            with open(args.passphrase_file, encoding="utf-8") as handle:
                known = read_known_passphrases(handle)
        with open(args.log, encoding="utf-8") as handle:
            entries, found = scan(handle, known)
    except (OSError, UnreadableLog) as error:
        print(f"UNREADABLE: {type(error).__name__}: {error}")
        return EXIT_UNREADABLE
    if entries == 0:
        print("UNREADABLE: the log has no entries, so nothing was scanned")
        return EXIT_UNREADABLE
    if found:
        for number, reason in found:
            print(f"RED: line {number}: {reason}")
        return EXIT_FOUND
    print(f"CLEAN: {entries} entries, no passphrase in a URL")
    return EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
