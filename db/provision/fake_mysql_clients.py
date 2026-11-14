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
import json, os, re, sys, time
CONFIG = __CONFIG__
LOG = __LOG__
COUNTER = LOG + ".locks"
POSITIONS = LOG + ".positions"
SCHEMA_LISTS = LOG + ".schema-lists"

def tick(path):
    """How many times this has been called before, counting from zero."""
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("x")
    with open(path, encoding="utf-8") as handle:
        return len(handle.read()) - 1

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

def listing(statement, tables):
    """The base tables the real listing would return: every one, or only the
    schemas a `TABLE_SCHEMA IN (...)` scope names."""
    scoped = re.search(r"TABLE_SCHEMA IN \(([^)]*)\)", statement)
    if scoped is None:
        return tables
    names = re.findall(r"'([^']*)'", scoped.group(1))
    return [pair for pair in tables if pair[0] in names]

if "-e" in argv and argv[argv.index("-e") + 1].startswith("SELECT TABLE_SCHEMA"):
    statement = argv[argv.index("-e") + 1]
    log("list_tables", sql=statement)
    for schema, table in listing(statement, config.get("tables_at_plan", config["tables"])):
        print(f"{schema}\t{table}")
    sys.exit(0)
if "-e" in argv and argv[argv.index("-e") + 1].startswith("SELECT SCHEMA_NAME"):
    log("list_schemas", sql=argv[argv.index("-e") + 1])
    if config.get("list") == "fail":
        eprint("ERROR 1045 (28000): Access denied for user")
        sys.exit(1)
    call = tick(SCHEMA_LISTS)
    named = config.get("schemas_second") if call > 0 and "schemas_second" in config else config.get("schemas")
    if named is None:
        named = sorted({schema for schema, _ in config["tables"]})
    for schema in named:
        print(schema)
    sys.exit(0)
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
            for schema, table in listing(statement, tables):
                print(f"{schema}\t{table}")
        elif statement.startswith("LOCK TABLES"):
            locked = [list(pair) for pair in re.findall(r"`([^`]*)`\.`([^`]*)` READ", statement)]
            # With `timeout_on` named, only a statement that locks that table
            # is the slow one, and only its attempts count against `lock`.
            timeout_on = config.get("timeout_on")
            if timeout_on is None or timeout_on in locked:
                plan = config.get("lock", ["ok"])
                mode = plan[min(tick(COUNTER), len(plan) - 1)]
            else:
                mode = "ok"
            # A transaction already holding `holds` and asking for `wants`
            # closes a cycle with a coordinator that took `wants` first and
            # is now asking for `holds`: the server rolls the transaction
            # back with error 1213 (the coordinator's own request carries
            # the heavier deadlock weight). Tables are taken in the order the
            # statement names them; a timeout stops the walk at `timeout_on`.
            reached = len(locked)
            if mode == "timeout" and timeout_on in locked:
                reached = locked.index(timeout_on) + 1
            for transaction in config.get("inflight", []):
                if transaction["wants"] in locked and transaction["holds"] in locked:
                    wanted, held = locked.index(transaction["wants"]), locked.index(transaction["holds"])
                    if wanted < held < reached:
                        log("victim", transaction=transaction["name"], error=1213, sql=statement)
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
            sequence = config.get("log_status_sequence")
            if sequence:
                print(sequence[min(tick(POSITIONS), len(sequence) - 1)])
            else:
                print(config.get("log_status", json.dumps({"binary_log_file": "mysql-bin.000007", "binary_log_position": 1234})))
        elif statement == "SHOW MASTER STATUS":
            for row in config.get("master_status", ["mysql-bin.000009\t4321\t\t\t"]):
                print(row)
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
if config.get("dump_declares_databases") and "--databases" in argv:
    for name in argv[argv.index("--databases") + 1:]:
        print(f"CREATE DATABASE /*!32312 IF NOT EXISTS*/ `{name}`;")
        print(f"USE `{name}`;")
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

    def victims(self, transaction: str | None = None) -> list[dict]:
        """Transactions the fake server rolled back with error 1213."""
        return [
            event
            for event in self.events()
            if event["kind"] == "victim" and (transaction is None or event["transaction"] == transaction)
        ]

    def lock_statements(self) -> list[str]:
        return [sql for sql in self.statements() if sql.startswith("LOCK TABLES")]

    def kills(self) -> list[str]:
        return [event["sql"] for event in self.events() if event["kind"] == "kill"]

    def starts(self, binary: str) -> list[dict]:
        return [event for event in self.events() if event["kind"] == "start" and event["binary"] == binary]
