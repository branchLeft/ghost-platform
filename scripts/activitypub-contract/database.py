"""The database side of the contract harness: accounts, grants and read-backs.

Database tooling for a throwaway server, declared in `.standards-db-tooling`.
Every statement runs as the server's root account inside the database
container, so the harness holds no client library.
"""

from __future__ import annotations

import secrets
from collections.abc import Sequence
from dataclasses import dataclass

from dockerx import DockerError, Lab, docker, wait_until

# Made fresh for every run: nothing about a throwaway server is committed.
ROOT_PASSWORD = secrets.token_hex(16)
SCHEMA = "activitypub"


@dataclass(frozen=True)
class DatabaseImage:
    label: str
    image: str
    mysqld_version_prefix: str


class Database:
    """One running database server on the lab network."""

    def __init__(self, lab: Lab, image: DatabaseImage, role: str = "db") -> None:
        self.lab = lab
        self.image = image
        self.role = role
        self.container = lab.start(
            role,
            image.image,
            env={"MYSQL_ROOT_PASSWORD": ROOT_PASSWORD},
        )

    def wait_ready(self) -> None:
        wait_until(
            self._answers_on_network,
            seconds=300,
            what=f"{self.image.label} to accept connections",
            every=2.0,
        )

    def _answers_on_network(self) -> bool:
        out = self.query("SELECT 1")
        return out.strip() == "1"

    def query(self, statement: str, *, check: bool = True) -> str:
        """Run one statement as root; return its tab-separated rows."""
        try:
            return docker(
                "exec",
                "-e",
                f"MYSQL_PWD={ROOT_PASSWORD}",
                self.container,
                "mysql",
                "-uroot",
                "-h127.0.0.1",
                "-P3306",
                "--protocol=tcp",
                "-N",
                "-B",
                "-e",
                statement,
                check=check,
            )
        except DockerError:
            if check:
                raise
            return ""

    def reset_schema(self) -> None:
        """An empty `activitypub` schema, with no accounts of the harness left."""
        self.query(f"DROP DATABASE IF EXISTS {SCHEMA}")
        self.query(f"CREATE DATABASE {SCHEMA} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")

    def create_account(self, user: str, password: str, privileges: Sequence[str]) -> None:
        """Replace `user` with an account holding exactly `privileges` on the schema."""
        self.query(f"DROP USER IF EXISTS '{user}'@'%'")
        self.query(f"CREATE USER '{user}'@'%' IDENTIFIED BY '{password}'")
        if privileges:
            self.query(f"GRANT {', '.join(privileges)} ON {SCHEMA}.* TO '{user}'@'%'")

    def version(self) -> str:
        return self.query("SELECT VERSION()").strip()

    def variable(self, name: str) -> str:
        rows = self.query(f"SHOW GLOBAL VARIABLES LIKE '{name}'").strip().split("\t")
        return rows[1] if len(rows) == 2 else ""

    def status(self, name: str) -> str:
        rows = self.query(f"SHOW GLOBAL STATUS LIKE '{name}'").strip().split("\t")
        return rows[1] if len(rows) == 2 else ""

    def table_names(self) -> list[str]:
        out = self.query(
            f"SELECT table_name FROM information_schema.tables WHERE table_schema = '{SCHEMA}' ORDER BY 1"
        )
        return [line for line in out.splitlines() if line]

    def table_collations(self) -> list[str]:
        out = self.query(
            f"SELECT DISTINCT table_collation FROM information_schema.tables WHERE table_schema = '{SCHEMA}' ORDER BY 1"
        )
        return [line for line in out.splitlines() if line]

    def column_collations(self) -> list[str]:
        out = self.query(
            "SELECT DISTINCT collation_name FROM information_schema.columns "
            f"WHERE table_schema = '{SCHEMA}' AND collation_name IS NOT NULL ORDER BY 1"
        )
        return [line for line in out.splitlines() if line]

    def migration_version(self) -> str:
        return self.query(
            f"SELECT CONCAT(version, ':', dirty) FROM {SCHEMA}.schema_migrations"
        ).strip()

    def sites(self) -> list[list[str]]:
        out = self.query(
            f"SELECT host, IF(ghost_uuid IS NULL, 'no-uuid', 'uuid'), IF(webhook_secret IS NULL OR webhook_secret = '', 'no-secret', 'secret') FROM {SCHEMA}.sites ORDER BY 1"
        )
        return [line.split("\t") for line in out.splitlines() if line]

    def connections(self) -> int:
        return int(
            self.query(
                "SELECT COUNT(*) FROM information_schema.processlist WHERE user = 'ap_service'"
            ).strip()
            or "0"
        )

    def delete_site(self, host: str) -> None:
        self.query(f"DELETE FROM {SCHEMA}.sites WHERE host = '{host}'")
