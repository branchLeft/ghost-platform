"""Runs the pinned upstream ActivityPub service beside one Ghost and records what it does.

    python3 harness.py --ghost-image IMAGE [--service-image IMAGE --migrate-image IMAGE]
                       [--observations FILE] [--learn]

Without `--service-image` the pinned source is fetched and both upstream images
are built from it. The exit code is 0 only when every fact in contract.FACTS was
observed as stated. Layout of the lab and what each phase proves: CONTRACT.md.
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import cast

import contract
from contract import Json
from database import SCHEMA, Database, DatabaseImage
from dockerx import (
    DockerError,
    Lab,
    Response,
    docker,
    exec_in,
    http_request,
    is_running,
    logs,
    wait_until,
)
from topology import (
    OWNER_EMAIL,
    OWNER_PASSWORD,
    SITE_NAME,
    STORAGE_URL,
    Topology,
    make_certificate,
)

PERCONA = DatabaseImage(
    "percona-8.0.46",
    "docker.io/percona/percona-server:8.0@sha256:a4ba7d1afd325f40bc6d65b6455fb4f15388638dfa39e3b85f9755755fd9ec2d",
    "8.0.46",
)
MYSQL84 = DatabaseImage(
    "mysql-8.4.13",
    "docker.io/library/mysql:8.4.13@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902",
    "8.4.13",
)
MIGRATE_USER = "ap_migrate"
# Made fresh for every run; hex, so it is safe inside the migrate image's URL.
MIGRATE_PASSWORD = secrets.token_hex(16)
SERVICE_USER = "ap_service"
SERVICE_PASSWORD = secrets.token_hex(16)
READONLY_PASSWORD = secrets.token_hex(16)
STORAGE_PATH = "/var/ap-content"
OTHER_STORAGE_URL = "https://files.example.test/.ghost/activitypub/local-storage"

Observations = dict[str, Json]
PARTIAL: Observations = {}


def jlist(items: Iterable[str]) -> Json:
    out: list[Json] = []
    out.extend(items)
    return out


def service_env(
    db_host: str = "db", drop: tuple[str, ...] = (), extra: Mapping[str, str] | None = None
) -> dict[str, str]:
    """Exactly the contract's required variables, minus `drop`, plus `extra`."""
    values = {
        "NODE_ENV": "production",
        "MYSQL_HOST": db_host,
        "MYSQL_PORT": "3306",
        "MYSQL_USER": SERVICE_USER,
        "MYSQL_PASSWORD": SERVICE_PASSWORD,
        "MYSQL_DATABASE": SCHEMA,
        "LOCAL_STORAGE_PATH": STORAGE_PATH,
        "LOCAL_STORAGE_HOSTING_URL": STORAGE_URL,
    }
    env = {
        name: values.get(name, "unset-in-harness")
        for name in contract.REQUIRED_ENV
        if name not in drop
    }
    env.update(extra or {})
    return env


def build_images(workdir: Path) -> tuple[str, str]:
    """Fetch the pinned commit and build the service (production target) and migrate images."""
    source = workdir / "upstream"
    source.mkdir()
    for argv in (
        ["git", "init", "-q", str(source)],
        ["git", "-C", str(source), "remote", "add", "origin", contract.UPSTREAM_REPOSITORY],
        [
            "git",
            "-C",
            str(source),
            "fetch",
            "-q",
            "--depth",
            "1",
            "origin",
            contract.UPSTREAM_COMMIT,
        ],
        ["git", "-C", str(source), "checkout", "-q", "FETCH_HEAD"],
    ):
        subprocess.run(argv, check=True, capture_output=True)
    head = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if head != contract.UPSTREAM_COMMIT:
        raise RuntimeError(f"fetched {head}, pinned {contract.UPSTREAM_COMMIT}")
    short = head[:12]
    service = f"apc-upstream-service:{short}"
    migrate = f"apc-upstream-migrate:{short}"
    docker("build", "--target", "production", "--tag", service, str(source), timeout=1800)
    docker("build", "--tag", migrate, str(source / "migrate"), timeout=1800)
    return service, migrate


def inspect_image(image: str, template: str) -> Json:
    return cast(Json, json.loads(docker("image", "inspect", "--format", template, image)))


class Harness:
    def __init__(
        self, lab: Lab, topology_dir: Path, service_image: str, migrate_image: str, ghost_image: str
    ) -> None:
        self.lab = lab
        self.service_image = service_image
        self.migrate_image = migrate_image
        self.ghost_image = ghost_image
        self.obs: Observations = PARTIAL
        self.certs = topology_dir / "tls"
        self.certs.mkdir()
        make_certificate(self.certs)
        self.database: Database | None = None
        self.cookie = ""
        self.unregistered: dict[str, Json] = {}

    # ---- helpers ---------------------------------------------------------

    def migrate(
        self, db: Database, privileges: tuple[str, ...], dsn_form: bool = False
    ) -> tuple[int, str]:
        db.reset_schema()
        db.create_account(MIGRATE_USER, MIGRATE_PASSWORD, privileges)
        if dsn_form:
            env = {
                "MYSQL_DB": f"mysql://{MIGRATE_USER}:{MIGRATE_PASSWORD}@tcp({db.role}:3306)/{SCHEMA}"
            }
        else:
            env = {
                "DB_HOST": db.role,
                "DB_PORT": "3306",
                "DB_USER": MIGRATE_USER,
                "DB_PASS": MIGRATE_PASSWORD,
                "DB_NAME": SCHEMA,
            }
        return self.lab.run_once(self.migrate_image, env=env)

    def start_service(
        self, role: str, env: Mapping[str, str], topology: Topology
    ) -> tuple[str, int]:
        name = topology.start_service(dict(env), role=role)
        return name, topology.service_port(name)

    def direct(
        self,
        port: int,
        method: str,
        path: str,
        *,
        host: str | None = SITE_NAME,
        headers: Mapping[str, str] | None = None,
        body: bytes = b"",
    ) -> Response:
        return http_request(port, method, path, host=host, headers=headers, body=body)

    def wait_ping(self, port: int, name: str, seconds: float = 60) -> bool:
        try:
            wait_until(
                lambda: self.direct(port, "GET", "/ping").status == 200 and is_running(name),
                seconds=seconds,
                what=f"{name} to answer /ping",
                every=0.5,
            )
        except TimeoutError:
            return False
        return True

    def stop(self, name: str) -> None:
        docker("rm", "-f", "-v", name, check=False)
        if name in self.lab.containers:
            self.lab.containers.remove(name)

    # ---- phase 1: images -------------------------------------------------

    def observe_images(self) -> None:
        o = self.obs
        o["service.image.cmd"] = inspect_image(self.service_image, "{{json .Config.Cmd}}")
        o["service.image.entrypoint"] = inspect_image(
            self.service_image, "{{json .Config.Entrypoint}}"
        )
        o["service.image.workdir"] = inspect_image(
            self.service_image, "{{json .Config.WorkingDir}}"
        )
        o["service.image.exposed_ports"] = jlist(
            sorted(
                cast(
                    dict[str, Json],
                    inspect_image(self.service_image, "{{json .Config.ExposedPorts}}"),
                )
            )
        )
        user = inspect_image(self.service_image, "{{json .Config.User}}")
        o["service.image.user"] = user or "root"
        env = cast(list[str], inspect_image(self.service_image, "{{json .Config.Env}}"))
        o["service.image.baked_env"] = jlist(
            sorted(
                e.split("=", 1)[0] for e in env if e.startswith(("NODE_ENV=", "PORT=", "MYSQL_"))
            )
        )
        o["service.image.node_version"] = docker(
            "run", "--rm", "--entrypoint", "node", self.service_image, "--version"
        ).strip()
        o["service.image.has_healthcheck"] = (
            inspect_image(self.service_image, "{{json .Config.Healthcheck}}") is not None
        )
        o["migrate.image.cmd"] = inspect_image(self.migrate_image, "{{json .Config.Cmd}}")
        o["migrate.image.entrypoint"] = inspect_image(
            self.migrate_image, "{{json .Config.Entrypoint}}"
        )
        o["migrate.image.workdir"] = inspect_image(
            self.migrate_image, "{{json .Config.WorkingDir}}"
        )
        o["migrate.image.tool_version"] = docker(
            "run", "--rm", "--entrypoint", "migrate", self.migrate_image, "-version", check=False
        ).strip()
        o["migrate.image.user"] = (
            inspect_image(self.migrate_image, "{{json .Config.User}}") or "root"
        )

    # ---- phase 2: databases and migration --------------------------------

    def observe_primary_database(self, db: Database) -> None:
        o = self.obs
        label = db.image.label
        o[f"db.{label}.version_prefix"] = db.version().startswith(db.image.mysqld_version_prefix)
        o["db.server.character_set"] = db.variable("character_set_server")
        o["db.server.collation"] = db.variable("collation_server")
        o["db.server.max_connections"] = int(db.variable("max_connections"))
        full = contract.MIGRATE_PRIVILEGES
        code, _ = self.migrate(db, full)
        o["migrate.full_privileges.exit"] = code
        o["migrate.version"] = db.migration_version()
        o["migrate.tables"] = list(db.table_names())
        o["migrate.table_collations"] = list(db.table_collations())
        o["migrate.column_collations"] = list(db.column_collations())
        again_code, again_out = self.lab.run_once(
            self.migrate_image,
            env={
                "DB_HOST": db.role,
                "DB_PORT": "3306",
                "DB_USER": MIGRATE_USER,
                "DB_PASS": MIGRATE_PASSWORD,
                "DB_NAME": SCHEMA,
            },
        )
        o["migrate.rerun.exit"] = again_code
        o["migrate.rerun.says_no_change"] = "no change" in again_out
        necessity: dict[str, Json] = {}
        for privilege in full:
            reduced = tuple(p for p in full if p != privilege)
            reduced_code, _ = self.migrate(db, reduced)
            necessity[privilege] = "required" if reduced_code != 0 else "not needed"
        o["migrate.privilege_necessity"] = necessity
        code_dsn, _ = self.migrate(db, full, dsn_form=True)
        o["migrate.dsn_form.exit"] = code_dsn
        self.migrate(db, full)

    def observe_second_database(self, db: Database, topology: Topology) -> None:
        label = db.image.label
        self.obs[f"db.{label}.version_prefix"] = db.version().startswith(
            db.image.mysqld_version_prefix
        )
        code, _ = self.migrate(db, contract.MIGRATE_PRIVILEGES)
        self.obs[f"db.{label}.migrate_exit"] = code
        self.obs[f"db.{label}.migration_version"] = db.migration_version()
        self.obs[f"db.{label}.table_count"] = len(db.table_names())
        db.create_account(SERVICE_USER, SERVICE_PASSWORD, contract.SERVICE_PRIVILEGES)
        name = topology.start_service(service_env(db_host=db.role), role="service-b")
        port = topology.service_port(name)
        self.obs[f"db.{label}.service_ping"] = self.wait_ping(port, name)
        self.obs[f"db.{label}.service_reaches_database"] = self.direct(
            port, "GET", "/.well-known/nodeinfo"
        ).status
        self.stop(name)

    # ---- phase 3: the service alone --------------------------------------

    def classify(self, name: str, port: int) -> str:
        if not self.wait_ping(port, name, seconds=25):
            return "exits" if not is_running(name) else "never answers /ping"
        database_answer = self.direct(port, "GET", "/.well-known/nodeinfo").status
        if database_answer == 403:
            return "works"
        return f"serves /ping, database route answers {database_answer}"

    def observe_service_alone(self, topology: Topology, db: Database) -> None:
        o = self.obs
        db.create_account(SERVICE_USER, SERVICE_PASSWORD, contract.SERVICE_PRIVILEGES)
        name, port = self.start_service("service-a", service_env(), topology)
        started = time.monotonic()
        ready = self.wait_ping(port, name)
        o["service.baseline.ready_seconds"] = round(time.monotonic() - started, 1)
        o["service.baseline.ping"] = ready
        o["service.baseline.database_route"] = self.direct(
            port, "GET", "/.well-known/nodeinfo"
        ).status
        boot_log = logs(name)
        o["service.boot.queue_line"] = "Message queue is disabled" in boot_log
        o["service.boot.kv_store_line"] = "Using MySQL KvStore for Fedify" in boot_log
        o["service.boot.listen_line"] = bool(re.search(r"listening on :::8080", boot_log))
        o["service.boot.process_user"] = exec_in(name, "id", "-u").strip()
        unregistered: dict[str, Json] = {}
        for route in contract.ROUTES:
            unregistered[route.key] = self.direct(port, route.method, route.path).status
        self.unregistered = unregistered
        o["route.no_host_header"] = self.direct(
            port, "GET", "/.well-known/nodeinfo", host=None
        ).status
        o["route.ping_any_host"] = self.direct(port, "GET", "/ping", host="anything.example").status
        self.stop(name)
        for var in contract.REQUIRED_ENV:
            missing_name, missing_port = self.start_service(
                "service-missing", service_env(drop=(var,)), topology
            )
            o[f"env.missing.{var}"] = self.classify(missing_name, missing_port)
            self.stop(missing_name)
        bad_name, bad_port = self.start_service(
            "service-bad-db", service_env(db_host="no-such-database-host"), topology
        )
        self.wait_ping(bad_port, bad_name)
        o["health.ping_with_database_unreachable"] = self.direct(bad_port, "GET", "/ping").status
        o["health.database_route_with_database_unreachable"] = self.direct(
            bad_port, "GET", "/.well-known/nodeinfo"
        ).status
        self.stop(bad_name)

    # ---- phase 4: beside one Ghost ---------------------------------------

    def ghost_json(
        self,
        topology: Topology,
        method: str,
        path: str,
        payload: Json | None = None,
        cookie: str = "",
    ) -> tuple[int, Json]:
        headers = {"Content-Type": "application/json", "Origin": f"https://{SITE_NAME}"}
        if cookie:
            headers["Cookie"] = cookie
        status, body, _ = topology.edge_request(
            method,
            path,
            headers=headers,
            body=json.dumps(payload).encode() if payload is not None else b"",
        )
        try:
            return status, cast(Json, json.loads(body.decode()))
        except ValueError:
            return status, body.decode(errors="replace")

    def owner_token(self, topology: Topology) -> str:
        status, data = self.ghost_json(
            topology, "GET", "/ghost/api/admin/identities/", cookie=self.cookie
        )
        if status != 200 or not isinstance(data, dict):
            raise RuntimeError(f"identities answered {status}")
        identities = cast(list[dict[str, Json]], data["identities"])
        return str(identities[0]["token"])

    def authed(
        self,
        topology: Topology,
        method: str,
        path: str,
        *,
        body: bytes = b"",
        content_type: str = "application/json",
        headers: Mapping[str, str] | None = None,
    ) -> tuple[int, bytes, dict[str, str]]:
        merged = {
            "Authorization": f"Bearer {self.owner_token(topology)}",
            "Content-Type": content_type,
            **(headers or {}),
        }
        return topology.edge_request(method, path, headers=merged, body=body)

    def observe_beside_ghost(self, topology: Topology, db: Database) -> None:
        o = self.obs
        topology.start_ghost({"security__staffDeviceVerification": "false"})
        topology.start_edge()
        topology.wait_for_ghost()
        status, _ = self.ghost_json(
            topology,
            "POST",
            "/ghost/api/admin/authentication/setup/",
            {
                "setup": [
                    {
                        "name": "OWNER_NAME",
                        "email": OWNER_EMAIL,
                        "password": OWNER_PASSWORD,
                        "blogTitle": "SITE_TITLE",
                    }
                ]
            },
        )
        o["ghost.owner_setup_status"] = status
        headers = {"Content-Type": "application/json", "Origin": f"https://{SITE_NAME}"}
        login = http_request(
            topology.edge_port(),
            "POST",
            "/ghost/api/admin/session/",
            host=SITE_NAME,
            headers=headers,
            body=json.dumps({"username": OWNER_EMAIL, "password": OWNER_PASSWORD}).encode(),
            tls_ca=topology.ca,
            sni=SITE_NAME,
        )
        o["ghost.owner_login_status"] = login.status
        self.cookie = login.cookie_header
        docker("restart", topology.ghost_name)
        topology.wait_for_ghost()
        wait_until(
            lambda: len(db.sites()) > 0, seconds=120, what="Ghost to register its site", every=2.0
        )
        o["registration.sites_row"] = [list(row) for row in db.sites()]
        ghost_log = logs(topology.ghost_name)
        o["ghost.log.webhooks_in_correct_state"] = (
            "ActivityPub webhooks in correct state" in ghost_log
        )
        webhooks = exec_in(
            topology.ghost_name,
            "sh",
            "-c",
            "cd /var/lib/ghost/current && node -e \"const k=require('knex')({client:'better-sqlite3',connection:{filename:'/var/lib/ghost/content/data/ghost.db'},useNullAsDefault:true});"
            "k('webhooks').select('event','target_url').then(r=>{console.log(JSON.stringify(r));process.exit(0)})\"",
        )
        rows = cast(list[dict[str, str]], json.loads(webhooks.strip().splitlines()[-1]))
        o["ghost.webhooks"] = jlist(
            sorted(f"{row['event']} -> {row['target_url'].split(SITE_NAME, 1)[1]}" for row in rows)
        )
        direct_status = exec_in(
            topology.ghost_name,
            "sh",
            "-c",
            f"wget -S -O /dev/null --header 'Host: {SITE_NAME}' --header 'X-Forwarded-Proto: https' http://127.0.0.1:2368/.ghost/activitypub/v1/site/ 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | tail -1",
            check=False,
        ).strip()
        o["ghost.serves_activitypub_paths_itself"] = direct_status != "HTTP/1.1 404"
        self.observe_edge_traffic(topology)

    def observe_edge_traffic(self, topology: Topology) -> None:
        o = self.obs
        service_ip = docker(
            "inspect",
            "-f",
            '{{(index .NetworkSettings.Networks "' + self.lab.network + '").IPAddress}}',
            topology.service_name,
        ).strip()
        ghost_ip = docker(
            "inspect",
            "-f",
            '{{(index .NetworkSettings.Networks "' + self.lab.network + '").IPAddress}}',
            topology.ghost_name,
        ).strip()
        from_service: set[str] = set()
        from_ghost: set[str] = set()
        for line in topology.edge_log().splitlines():
            found = re.match(r"^(\S+) - - \[[^\]]+\] \"(\w+) (\S+) HTTP/[\d.]+\" (\d+)", line)
            if not found:
                continue
            client, method, path, _ = found.groups()
            clean = re.sub(r"\?.*$", "", path)
            if client == service_ip and clean.startswith("/ghost/"):
                from_service.add(f"{method} {clean}")
            if client == ghost_ip and method == "GET" and clean.startswith("/.ghost/activitypub/"):
                from_ghost.add(f"{method} {clean}")
        o["registration.service_fetches_from_site"] = jlist(sorted(from_service))
        o["registration.ghost_requests_to_service"] = jlist(sorted(from_ghost))

    def observe_public(self, topology: Topology, db: Database) -> None:
        o = self.obs
        service_name = topology.service_name
        port = topology.service_port(service_name)
        registered: dict[str, Json] = {}
        for route in contract.ROUTES:
            registered[route.key] = self.direct(port, route.method, route.path).status
        for route in contract.ROUTES:
            o[route.key] = {
                "unregistered": self.unregistered[route.key],
                "registered": registered[route.key],
            }
        o["auth.v1_site_anonymous"] = self.direct(port, "GET", "/.ghost/activitypub/v1/site").text
        status, body, _ = self.authed(topology, "GET", "/.ghost/activitypub/v1/site")
        o["auth.v1_site_owner_token"] = status
        site = cast(dict[str, Json], json.loads(body.decode()))
        o["auth.v1_site_response_fields"] = jlist(sorted(site))
        other = http_request(
            port,
            "GET",
            "/.ghost/activitypub/v1/site",
            host="other.test",
            headers={"Authorization": f"Bearer {self.owner_token(topology)}"},
        )
        o["auth.token_checked_against_host_jwks"] = f"{other.status} {other.text}"
        actor_headers = {"Accept": "application/activity+json"}
        actor = self.direct(port, "GET", "/.ghost/activitypub/users/index", headers=actor_headers)
        actor_id = cast(dict[str, Json], actor.json()).get("id")
        o["headers.actor_id"] = actor_id
        forwarded_host = self.direct(
            port,
            "GET",
            "/.ghost/activitypub/users/index",
            headers={**actor_headers, "X-Forwarded-Host": "evil.example"},
        )
        o["headers.x_forwarded_host_changes_actor_id"] = (
            cast(dict[str, Json], forwarded_host.json()).get("id") != actor_id
        )
        forwarded_proto = self.direct(
            port,
            "GET",
            "/.ghost/activitypub/users/index",
            headers={**actor_headers, "X-Forwarded-Proto": "http"},
        )
        o["headers.x_forwarded_proto_changes_actor_id"] = (
            cast(dict[str, Json], forwarded_proto.json()).get("id") != actor_id
        )
        forwarded_for = self.direct(
            port,
            "GET",
            "/.ghost/activitypub/users/index",
            headers={**actor_headers, "X-Forwarded-For": "203.0.113.9"},
        )
        o["headers.x_forwarded_for_changes_actor_id"] = (
            cast(dict[str, Json], forwarded_for.json()).get("id") != actor_id
        )
        o["headers.unknown_host_answer"] = self.direct(
            port, "GET", "/.ghost/activitypub/users/index", host="other.test", headers=actor_headers
        ).text
        o["headers.accept_header_forced"] = self.direct(
            port, "GET", "/.ghost/activitypub/users/index", headers={"Accept": "text/html"}
        ).headers.get("content-type", "")
        self.observe_storage(topology)
        self.observe_private_lookup(topology, db)
        self.observe_site_write_privilege(topology, db)

    def observe_storage(self, topology: Topology) -> None:
        o = self.obs
        boundary = "----apc"
        png = self.tiny_png()
        body = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
            + png
            + f"\r\n--{boundary}--\r\n".encode()
        )
        status, answer, _ = self.authed(
            topology,
            "POST",
            "/.ghost/activitypub/v1/upload/image",
            body=body,
            content_type=f"multipart/form-data; boundary={boundary}",
        )
        o["storage.upload_status"] = status
        file_url = (
            str(cast(dict[str, Json], json.loads(answer.decode())).get("fileUrl", ""))
            if status == 200
            else ""
        )
        o["storage.file_url_starts_with_hosting_url"] = file_url.startswith(
            STORAGE_URL + "/images/"
        )
        relative = file_url[len(STORAGE_URL) :] if file_url.startswith(STORAGE_URL) else ""
        listing = exec_in(topology.service_name, "find", STORAGE_PATH, "-type", "f").split()
        o["storage.file_written_under_path"] = [p[len(STORAGE_PATH) :] for p in listing] == [
            relative
        ]
        o["storage.file_served_by_service_in_production"] = topology.edge_request(
            "GET", "/.ghost/activitypub/local-storage" + relative
        )[0]
        o["storage.dir_owner"] = exec_in(
            topology.service_name, "stat", "-c", "%U", STORAGE_PATH
        ).strip()
        other_env = service_env(extra={"LOCAL_STORAGE_HOSTING_URL": OTHER_STORAGE_URL})
        name, port = self.start_service("service-files", other_env, topology)
        self.wait_ping(port, name)
        token = self.owner_token(topology)
        other_status = http_request(
            port,
            "POST",
            "/.ghost/activitypub/v1/upload/image",
            host=SITE_NAME,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "X-Forwarded-Proto": "https",
            },
            body=body,
        )
        other_url = (
            str(cast(dict[str, Json], json.loads(other_status.text)).get("fileUrl", ""))
            if other_status.status == 200
            else other_status.text
        )
        o["storage.hosting_url_is_global_not_per_host"] = other_url.startswith(
            OTHER_STORAGE_URL + "/images/"
        )
        self.stop(name)
        for var in ("LOCAL_STORAGE_PATH", "LOCAL_STORAGE_HOSTING_URL"):
            missing_name, missing_port = self.start_service(
                "service-missing", service_env(drop=(var,)), topology
            )
            if not self.wait_ping(missing_port, missing_name, seconds=25):
                o[f"storage.upload_without.{var}"] = "exits"
            else:
                result = http_request(
                    missing_port,
                    "POST",
                    "/.ghost/activitypub/v1/upload/image",
                    host=SITE_NAME,
                    headers={
                        "Authorization": f"Bearer {self.owner_token(topology)}",
                        "Content-Type": f"multipart/form-data; boundary={boundary}",
                        "X-Forwarded-Proto": "https",
                    },
                    body=body,
                )
                o[f"storage.upload_without.{var}"] = result.status
            self.stop(missing_name)

    @staticmethod
    def tiny_png() -> bytes:
        def chunk(kind: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + kind
                + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
            )

        raw = b"".join(b"\x00" + b"\xff\x00\x00" * 8 for _ in range(8))
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b"")
        )

    def observe_private_lookup(self, topology: Topology, db: Database) -> None:
        o = self.obs
        query = f"/.ghost/activitypub/v1/actions/search?query=@nobody@{SITE_NAME}"

        def lookups() -> int:
            pattern = re.compile(r"^\S+ - - .*webfinger\?resource=acct(:|%3A)nobody")
            return sum(1 for line in topology.edge_log().splitlines() if pattern.search(line))

        before = lookups()
        status, found, _ = self.authed(topology, "GET", query)
        o["private_lookup.production.search_status"] = status
        o["private_lookup.production.accounts_found"] = self.account_count(found)
        o["private_lookup.production.reached_the_site"] = lookups() - before
        testing_env = service_env(extra={"NODE_ENV": "testing", "ALLOW_PRIVATE_ADDRESS": "true"})
        name, port = self.start_service("service-testing", testing_env, topology)
        self.wait_ping(port, name)
        before = lookups()
        result = http_request(
            port,
            "GET",
            query,
            host=SITE_NAME,
            headers={
                "Authorization": f"Bearer {self.owner_token(topology)}",
                "X-Forwarded-Proto": "https",
            },
        )
        o["private_lookup.allowed.search_status"] = result.status
        o["private_lookup.allowed.accounts_found"] = self.account_count(result.body)
        o["private_lookup.allowed.reached_the_site"] = lookups() - before
        self.stop(name)

    @staticmethod
    def account_count(body: bytes) -> int:
        data = cast(dict[str, Json], json.loads(body.decode()))
        accounts = data.get("accounts")
        return len(accounts) if isinstance(accounts, list) else -1

    def observe_site_write_privilege(self, topology: Topology, db: Database) -> None:
        o = self.obs
        db.delete_site(SITE_NAME)
        db.create_account("ap_readonly", READONLY_PASSWORD, ("SELECT",))
        env = service_env(extra={"MYSQL_USER": "ap_readonly", "MYSQL_PASSWORD": READONLY_PASSWORD})
        name, port = self.start_service("service-readonly", env, topology)
        self.wait_ping(port, name)
        result = http_request(
            port,
            "GET",
            "/.ghost/activitypub/v1/site",
            host=SITE_NAME,
            headers={
                "Authorization": f"Bearer {self.owner_token(topology)}",
                "X-Forwarded-Proto": "https",
            },
        )
        o["db.service_select_only.register_status"] = result.status
        o["db.service_select_only.sites_rows"] = len(db.sites())
        self.stop(name)
        again = self.authed(topology, "GET", "/.ghost/activitypub/v1/site")
        o["db.service_dml_only.register_status"] = again[0]
        o["db.service_dml_only.sites_rows"] = len(db.sites())

    # ---- phase 5: restart, load, resources --------------------------------

    def observe_restart_and_load(self, topology: Topology, db: Database) -> None:
        o = self.obs
        name = topology.service_name
        port = topology.service_port(name)
        time.sleep(15)
        o["resources.idle.memory_mib"], o["resources.idle.cpu_percent"] = self.stats(name)
        o["db.idle_connections"] = db.connections()
        peak = self.load(name, port, db, requests=1500, workers=24)
        o["resources.loaded.memory_mib"] = peak["memory"]
        o["resources.loaded.cpu_percent"] = peak["cpu"]
        o["db.loaded_peak_connections"] = peak["connections"]
        o["db.loaded_failures"] = peak["failures"]
        self.stop(name)
        capped_name, capped_port = self.start_service(
            "service-capped", service_env(extra={"MYSQL_CONN_POOL_MAX": "3"}), topology
        )
        self.wait_ping(capped_port, capped_name)
        capped = self.load(capped_name, capped_port, db, requests=600, workers=24)
        o["db.pool_max_3.peak_connections"] = capped["connections"]
        o["db.pool_max_3.failures"] = capped["failures"]
        self.stop(capped_name)
        topology.service_name = self.start_service("service", service_env(), topology)[0]
        port = topology.service_port()
        self.wait_ping(port, topology.service_name)
        started = time.monotonic()
        docker("stop", "--time", "30", topology.service_name)
        o["restart.stop_seconds"] = round(time.monotonic() - started, 1)
        o["restart.exit_code"] = int(
            docker("inspect", "-f", "{{.State.ExitCode}}", topology.service_name).strip()
        )
        docker("start", topology.service_name)
        port = topology.service_port()
        o["restart.ready_again"] = self.wait_ping(port, topology.service_name)
        o["restart.site_survives"] = self.direct(
            port, "GET", f"/.well-known/webfinger?resource=acct:index@{SITE_NAME}"
        ).status

    def stats(self, name: str) -> tuple[float, float]:
        row = docker("stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", name).strip()
        memory, cpu = row.split("|")
        used = memory.split("/")[0].strip()
        number = float(re.sub(r"[A-Za-z]+", "", used))
        mib = (
            number
            if used.endswith("MiB")
            else number * 1024
            if used.endswith("GiB")
            else number / 1024
        )
        return round(mib, 1), float(cpu.rstrip("%"))

    def load(
        self, name: str, port: int, db: Database, requests: int, workers: int
    ) -> dict[str, float]:
        failures = 0
        lock = threading.Lock()
        remaining = requests
        samples: list[tuple[float, float, int]] = []
        done = threading.Event()

        def worker() -> None:
            nonlocal failures, remaining
            while True:
                with lock:
                    if remaining <= 0:
                        return
                    remaining -= 1
                try:
                    answer = self.direct(
                        port, "GET", f"/.well-known/webfinger?resource=acct:index@{SITE_NAME}"
                    )
                    if answer.status != 200:
                        with lock:
                            failures += 1
                except OSError:
                    with lock:
                        failures += 1

        def sampler() -> None:
            while not done.is_set():
                try:
                    memory, cpu = self.stats(name)
                    samples.append((memory, cpu, db.connections()))
                except (DockerError, ValueError):
                    pass

        threads = [threading.Thread(target=worker) for _ in range(workers)]
        watcher = threading.Thread(target=sampler)
        watcher.start()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        done.set()
        watcher.join()
        return {
            "memory": max((s[0] for s in samples), default=0.0),
            "cpu": max((s[1] for s in samples), default=0.0),
            "connections": float(max((s[2] for s in samples), default=0)),
            "failures": float(failures),
        }


PHASE_ERRORS = (
    TimeoutError,
    DockerError,
    RuntimeError,
    OSError,
    ValueError,
    KeyError,
    subprocess.SubprocessError,
)


def phase(name: str, step: Callable[[], None]) -> None:
    """Run one phase; a failure is recorded as an observation and the next phase still runs."""
    try:
        step()
    except PHASE_ERRORS as error:
        PARTIAL[f"harness.failed.{name}"] = f"{type(error).__name__}: {error}"[:400]


def run(args: argparse.Namespace) -> Observations:
    with tempfile.TemporaryDirectory(prefix="apc-harness-") as scratch, Lab() as lab:
        workdir = Path(scratch)
        service_image = args.service_image
        migrate_image = args.migrate_image
        if not service_image or not migrate_image:
            service_image, migrate_image = build_images(workdir)
        harness = Harness(lab, workdir, service_image, migrate_image, args.ghost_image)
        primary = Database(lab, PERCONA, role="db")
        secondary = Database(lab, MYSQL84, role="db2")
        topology = Topology(lab, primary, harness.certs, {}, service_image, args.ghost_image)

        def wait_databases() -> None:
            primary.wait_ready()
            secondary.wait_ready()

        def start_baseline() -> None:
            topology.service_name = topology.start_service(service_env(), role="service")

        phase("images", harness.observe_images)
        phase("database_ready", wait_databases)
        phase("primary_database", lambda: harness.observe_primary_database(primary))
        phase("second_database", lambda: harness.observe_second_database(secondary, topology))
        phase("service_alone", lambda: harness.observe_service_alone(topology, primary))
        phase("baseline_start", start_baseline)
        phase("beside_ghost", lambda: harness.observe_beside_ghost(topology, primary))
        phase("public", lambda: harness.observe_public(topology, primary))
        phase("restart_and_load", lambda: harness.observe_restart_and_load(topology, primary))
        return harness.obs


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--ghost-image", required=True)
    parser.add_argument("--service-image", default="")
    parser.add_argument("--migrate-image", default="")
    parser.add_argument(
        "--observations", default="", help="write every observation as JSON to this file"
    )
    parser.add_argument("--learn", action="store_true", help="print the observations and exit 0")
    args = parser.parse_args(argv)
    try:
        observed = run(args)
    finally:
        if args.observations:
            Path(args.observations).write_text(json.dumps(PARTIAL, indent=2, sort_keys=True) + "\n")
    if args.learn:
        print(json.dumps(observed, indent=2, sort_keys=True))
        return 0
    found = contract.problems(contract.FACTS, observed)
    found += [
        f"{key}: {value}" for key, value in observed.items() if key.startswith("harness.failed.")
    ]
    for line in found:
        print(f"RED  {line}")
    print(f"{len(contract.FACTS) - len(found)} of {len(contract.FACTS)} facts hold")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
