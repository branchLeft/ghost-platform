#!/usr/bin/env python3
"""Test support: fake `mysql` and `mysqldump` executables, real processes on
PATH, so `bounded_snapshot` and its callers are exercised through real
`subprocess.Popen`, real pipes and real kills. Each fake reads a JSON
config file and appends what it was asked to do to a JSON-lines log; both
paths are baked into the script, since the code under test passes its
children nothing but PATH. Not shipped to any host as a tool.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

_COMMON = r'''
import json, os, sys, time
CONFIG = __CONFIG__
LOG = __LOG__
COUNTER = LOG + ".locks"

def cfg():
    with open(CONFIG, encoding="utf-8") as handle:
        return json.load(handle)

def log(kind, **fields):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"t": time.monotonic(), "pid": os.getpid(), "kind": kind, **fields}) + "\n")

def eprint(text):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()

def password_seen(argv):
    for arg in argv:
        if arg.startswith("--defaults-extra-file="):
            with open(arg.split("=", 1)[1], encoding="utf-8") as handle:
                return handle.read()
    return None
'''

_MYSQL = r'''
argv = sys.argv[1:]
config = cfg()
log("start", binary="mysql", argv=argv, password=password_seen(argv), environ=sorted(os.environ))
if "-e" in argv:
    log("kill", sql=argv[argv.index("-e") + 1])
    mode = config.get("kill", "ok")
    if mode == "hang":
        time.sleep(60)
    if mode == "unknown":
        eprint("ERROR 1094 (HY000) at line 1: Unknown thread id: 42")
        sys.exit(1)
    if mode == "fail":
        eprint("ERROR 2003 (HY000): Can't connect to MySQL server")
        sys.exit(1)
    sys.exit(0)
if config.get("connect") == "fail":
    eprint("ERROR 1045 (28000): Access denied for user")
    sys.exit(1)
listed = 0
for line in sys.stdin:
    for statement in [part.strip() for part in line.split(";") if part.strip()]:
        log("stmt", sql=statement)
        if statement.startswith("SELECT '__"):
            print(statement[len("SELECT '"):-1])
        elif statement.startswith("SET "):
            pass
        elif statement == "SELECT CONNECTION_ID()":
            print(config.get("connection_id", 42))
        elif statement.startswith("SELECT TABLE_SCHEMA"):
            tables = config["tables"] if listed == 0 else config.get("tables_under_lock", config["tables"])
            listed += 1
            for schema, table in tables:
                print(f"{schema}\t{table}")
        elif statement.startswith("LOCK TABLES"):
            with open(COUNTER, "a", encoding="utf-8") as handle:
                handle.write("x")
            with open(COUNTER, encoding="utf-8") as handle:
                attempt = len(handle.read()) - 1
            plan = config.get("lock", ["ok"])
            mode = plan[min(attempt, len(plan) - 1)]
            if mode == "timeout":
                time.sleep(config.get("lock_delay", 0))
                eprint("ERROR 1205 (HY000) at line 1: Lock wait timeout exceeded; try restarting transaction")
                sys.exit(1)
            if mode == "error":
                eprint("ERROR 1227 (42000) at line 1: Access denied; you need the LOCK TABLES privilege")
                sys.exit(1)
            if mode == "hang":
                time.sleep(30)
        elif statement.startswith("SELECT LOCAL FROM performance_schema.log_status"):
            print(config.get("log_status", json.dumps({"binary_log_file": "mysql-bin.000007", "binary_log_position": 1234})))
        elif statement == "UNLOCK TABLES":
            if config.get("unlock") == "hang":
                time.sleep(30)
        else:
            eprint(f"ERROR 1064 (42000): fake mysql does not understand {statement!r}")
            sys.exit(1)
        sys.stdout.flush()
log("exit", binary="mysql")
'''

_MYSQLDUMP = r'''
argv = sys.argv[1:]
config = cfg()
log("start", binary="mysqldump", argv=argv, password=password_seen(argv), environ=sorted(os.environ))
if config.get("dump_echo"):
    print(" ".join(argv))
    print(password_seen(argv) or "")
    for name in sorted(os.environ):
        print(f"{name}={os.environ[name]}")
verbose = "-v" in argv
if verbose:
    eprint("-- Connecting to localhost...")
    eprint("-- Starting transaction...")
time.sleep(config.get("marker_delay", 0))
if verbose and config.get("marker", True):
    eprint("-- Setting savepoint...")
for line in config.get("dump_lines", ["-- dump content"]):
    print(line)
sys.stdout.flush()
for line in config.get("dump_stderr", []):
    eprint(line)
time.sleep(config.get("dump_sleep", 0))
log("exit", binary="mysqldump")
sys.exit(config.get("dump_exit", 0))
'''


class FakeMysqlClients:
    """Installs both fakes into `bin_dir`. `configure(**values)` replaces
    the config; `events()` reads the log back."""

    def __init__(self, bin_dir: str) -> None:
        self.bin_dir = pathlib.Path(bin_dir)
        self.config_path = self.bin_dir / "fake-mysql-config.json"
        self.log_path = self.bin_dir / "fake-mysql-log.jsonl"
        self.configure()
        for name, body in (("mysql", _MYSQL), ("mysqldump", _MYSQLDUMP)):
            script = (
                f"#!{sys.executable}\n"
                + _COMMON.replace("__CONFIG__", repr(str(self.config_path))).replace("__LOG__", repr(str(self.log_path)))
                + body
            )
            path = self.bin_dir / name
            path.write_text(script, encoding="utf-8")
            os.chmod(path, 0o755)

    def configure(self, **values) -> None:
        config = {"tables": [["ghost_blog", "settings"], ["ghost_blog", "users"]]}
        config.update(values)
        self.config_path.write_text(json.dumps(config), encoding="utf-8")

    def events(self) -> list[dict]:
        try:
            text = self.log_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def statements(self) -> list[str]:
        return [event["sql"] for event in self.events() if event["kind"] == "stmt"]

    def kills(self) -> list[str]:
        return [event["sql"] for event in self.events() if event["kind"] == "kill"]

    def starts(self, binary: str) -> list[dict]:
        return [event for event in self.events() if event["kind"] == "start" and event["binary"] == binary]
