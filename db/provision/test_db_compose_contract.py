#!/usr/bin/env python3
"""What `db/stack/compose.yml` must keep true, and nothing else checks.

`mysqld-exporter` crash-looped on db1 for four days while every existing test
passed. Nothing here started a container, so nothing noticed that v0.20.0 had
dropped `DATA_SOURCE_NAME` and that the variable was being handed to a binary
that discards it. The `:?` guard on it made that worse rather than better: it
refused to start when the variable was *absent* while tolerating it being
completely ineffective, which reads in review like the value is checked.

These assertions are the cheapest thing that would have failed instead. They
are contracts between this file and things that live outside it -- the
exporter's own configuration interface, the systemd unit template in
branchLeft/shared-infra, and the renderer beside this test -- so each one
breaks on the change that would otherwise only show up on the host.

shared-infra's hetzner/provision/test_compose_unit_contract.py states the same
`--wait` contract for the two stacks it commits, and names this one in its
`CONTRACT_DOES_NOT_REACH` register precisely because it cannot read it. This
is that missing half.

Line-based rather than a YAML parse: this repository's Python checks run on
the standard library alone, and the properties asserted here are all
single-line facts.
"""

from __future__ import annotations

import pathlib
import re
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
COMPOSE = REPO_ROOT / "db" / "stack" / "compose.yml"
DROP_IN = REPO_ROOT / "db" / "systemd" / "db.override.conf"
RENDERER = REPO_ROOT / "db" / "provision" / "render_exporter_my_cnf.py"

# Where the renderer writes, and where the drop-in expects to find itself once
# db/provision/ has been copied to the host. Both are stated in
# db/RUNBOOK-db.md; restated here so a change to either has to change this
# file too.
RENDERED_CNF_HOST_PATH = "/etc/branchleft/db-exporter.my.cnf"
RENDERER_HOST_PATH = "/opt/branchleft/db/provision/render_exporter_my_cnf.py"

SERVICE_INDENT = 2
SERVICE_HEADER = re.compile(rf"\A {{{SERVICE_INDENT}}}(?P<name>[A-Za-z0-9._-]+):\s*\Z")


def compose_text() -> str:
    return COMPOSE.read_text(encoding="utf-8")


def service_blocks() -> dict[str, list[str]]:
    """Every service under `services:`, mapped to its own lines.

    Stops at the first top-level key after `services:` so `volumes:` at the
    end of the file is not read as a service.
    """
    blocks: dict[str, list[str]] = {}
    in_services = False
    current: str | None = None
    for line in compose_text().splitlines():
        if line.startswith("services:"):
            in_services = True
            continue
        if not in_services:
            continue
        if line and not line[0].isspace():
            break
        match = SERVICE_HEADER.match(line)
        if match:
            current = match.group("name")
            blocks[current] = []
            continue
        if current is not None:
            blocks[current].append(line)
    return blocks


def uncommented(lines: list[str]) -> list[str]:
    """Lines with whole-line comments dropped.

    Every assertion below is about what Compose acts on. A path or a flag
    named in a comment explaining why it is *not* used would otherwise satisfy
    a substring check.
    """
    return [line for line in lines if not line.strip().startswith("#")]


class ServicesAreDiscovered(unittest.TestCase):
    """If the block parser silently found nothing, every test below vacuously
    passes -- which is the failure mode this whole module exists to prevent."""

    def test_both_services_are_found(self) -> None:
        self.assertEqual(set(service_blocks()), {"mysql", "mysqld-exporter"})

    def test_the_trailing_volumes_key_is_not_read_as_a_service(self) -> None:
        self.assertNotIn("volumes", service_blocks())


class TheExporterIsConfiguredByFile(unittest.TestCase):
    def test_data_source_name_appears_nowhere(self) -> None:
        # v0.20.0 removed it. Reintroducing it would not fail, and that is the
        # whole problem: it is read by nothing and refused by nothing.
        self.assertNotIn("DATA_SOURCE_NAME", compose_text())

    def test_the_exporter_passes_config_my_cnf(self) -> None:
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertIn("--config.my-cnf=/etc/mysqld-exporter/.my.cnf", block)

    def test_the_config_is_mounted_from_outside_the_stack_directory(self) -> None:
        # It has to exist before `docker compose up` runs, and
        # /opt/branchleft/db is re-copied wholesale by a deploy.
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertIn(f"{RENDERED_CNF_HOST_PATH}:/etc/mysqld-exporter/.my.cnf:ro", block)

    def test_the_exporter_declares_no_environment_block(self) -> None:
        # `docker inspect` renders every environment variable to anything that
        # can reach the Docker socket. The exporter's only secret is its
        # password and it now arrives as a file, so there is nothing left for
        # an environment block to carry.
        block = uncommented(service_blocks()["mysqld-exporter"])
        self.assertNotIn("    environment:", [line.rstrip() for line in block])

    def test_the_renderer_the_drop_in_runs_exists_in_this_repository(self) -> None:
        self.assertTrue(RENDERER.is_file())
        self.assertIn(RENDERER_HOST_PATH, DROP_IN.read_text(encoding="utf-8"))
        self.assertEqual(RENDERER.name, pathlib.PurePosixPath(RENDERER_HOST_PATH).name)


class TheRendererAndTheStackAgree(unittest.TestCase):
    """The socket path is a constant in the renderer and a flag in the compose
    file, written in two repositories' worth of separate places. If they drift
    the exporter falls back to TCP on 127.0.0.1:3306, where
    `'exporter'@'localhost'` does not exist -- an auth failure that reads like
    a wrong password rather than a wrong path."""

    def test_the_socket_matches_the_compose_mount_and_flag(self) -> None:
        import render_exporter_my_cnf as renderer

        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertIn(f"--mysqld.address=unix://{renderer.EXPORTER_SOCKET}", block)
        self.assertIn(f"./run/mysqld:{pathlib.PurePosixPath(renderer.EXPORTER_SOCKET).parent}", block)

    def test_the_renderer_writes_where_the_stack_mounts_from(self) -> None:
        import render_exporter_my_cnf as renderer

        self.assertEqual(str(renderer.DEFAULT_OUTPUT_PATH), RENDERED_CNF_HOST_PATH)


class NothingReachesMysqlOverTcp(unittest.TestCase):
    """The admin and service accounts are `'...'@'localhost'` and the socket is
    the only path to them. A fix that opened a TCP listener for the exporter
    would be a design change, and would arrive looking like a one-line flag."""

    def test_the_exporter_address_is_a_unix_socket(self) -> None:
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertIn("--mysqld.address=unix:///var/run/mysqld/mysqld.sock", block)

    def test_the_exporter_declares_no_host_port_address(self) -> None:
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertNotRegex(block, r"--mysqld\.address=(?!unix://)")

    def test_the_metrics_listener_stays_on_the_private_address(self) -> None:
        # `network_mode: host` means this address is the host's. 0.0.0.0 would
        # be a listener on every interface db1 ever gains, and would satisfy
        # every other assertion in this class.
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertIn("--web.listen-address=10.20.1.20:9104", block)
        self.assertNotIn("0.0.0.0", block)

    def test_no_service_publishes_a_port(self) -> None:
        # `network_mode: host` makes `ports:` a no-op that Compose warns about
        # rather than an error, so a published port here would read as a
        # working control and be none.
        for name, lines in service_blocks().items():
            with self.subTest(service=name):
                self.assertNotIn("    ports:", [line.rstrip() for line in uncommented(lines)])


class EveryServiceHasADeploySignal(unittest.TestCase):
    """`docker compose up --wait`, which branchleft-compose@.service runs, waits
    for *healthy* only where a service declares a healthcheck. Without one it
    waits for *running*, which a crash-looping container transiently is -- so
    the stack reports a clean start and branchleft-deploy's rollback, which
    fires on a non-zero `systemctl restart` and nothing else, never runs."""

    def test_every_service_declares_a_healthcheck(self) -> None:
        for name, lines in service_blocks().items():
            with self.subTest(service=name):
                headers = [line.rstrip() for line in uncommented(lines)]
                self.assertIn("    healthcheck:", headers)

    def test_no_healthcheck_is_disabled(self) -> None:
        # `disable: true` and `test: ["NONE"]` both leave the key in place
        # while removing the signal, so the test above cannot see them.
        text = compose_text()
        self.assertNotIn("disable: true", text)
        self.assertNotRegex(text, r"'NONE'|\"NONE\"")

    def test_the_healthcheck_probes_the_address_the_exporter_listens_on(self) -> None:
        # Two independently hard-coded constants one line apart. Asserted as a
        # pair so a change to the listen address cannot leave the healthcheck
        # probing a port nothing serves -- which reads as a broken exporter and
        # rolls back the MySQL image pin.
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        listen = re.search(r"--web\.listen-address=(\S+)", block)
        self.assertIsNotNone(listen)
        self.assertIn(f"http://{listen.group(1)}/metrics", block)

    def test_the_exporter_health_signal_is_mysql_up_not_liveness(self) -> None:
        # The failure this stack actually suffered leaves the process running
        # and /metrics answering 200. A liveness or HTTP-status probe reports
        # that as healthy; `mysql_up 1` is the first check that does not.
        block = "\n".join(uncommented(service_blocks()["mysqld-exporter"]))
        self.assertIn("mysql_up 1", block)


class TheDropInDoesNotDisableTheImagePin(unittest.TestCase):
    """`branchleft-compose@.service` loads /etc/branchleft/%i.image.env with no
    leading dash so a missing pin fails the start. That is right for this
    stack, which resolves `image: ${IMAGE}` and has branchleft-deploy writing
    the file. An `EnvironmentFile=` reset belongs only to inline-pinned stacks
    and would silently drop the pin here."""

    def test_the_drop_in_exists(self) -> None:
        self.assertTrue(DROP_IN.is_file())

    def test_the_drop_in_does_not_reset_environmentfile(self) -> None:
        directives = [
            line.strip()
            for line in DROP_IN.read_text(encoding="utf-8").splitlines()
            if not line.strip().startswith("#")
        ]
        self.assertNotIn("EnvironmentFile=", directives)

    def test_the_drop_in_does_not_reset_execstartpre(self) -> None:
        # A bare `ExecStartPre=` would drop the template's own
        # `docker compose pull`, so the stack would start on whatever digest
        # happened to be in the local image cache.
        directives = [
            line.strip()
            for line in DROP_IN.read_text(encoding="utf-8").splitlines()
            if not line.strip().startswith("#")
        ]
        self.assertNotIn("ExecStartPre=", directives)

    def test_the_compose_file_still_resolves_the_image_variable(self) -> None:
        self.assertIn("image: ${IMAGE}", compose_text())


if __name__ == "__main__":
    unittest.main()
