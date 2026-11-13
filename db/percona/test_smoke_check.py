"""Unit tests for smoke_check.py: its judgements on text, no Docker."""

from __future__ import annotations

import unittest

import smoke_check as sc

TEMPORARY_SERVER = (
    "2026-11-10T19:45:36.1Z 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. "
    "Version: '8.0.46-37'  socket: '/var/lib/mysql/mysql.sock'  port: 0  Percona Server (GPL), Release 37"
)
REAL_SERVER = TEMPORARY_SERVER.replace("port: 0 ", "port: 3306")

MAPS_CLEAN = (
    "ffff9a000000-ffff9a1c0000 r-xp 00000000 00:2a 123 /usr/sbin/mysqld\n"
    "ffff9b000000-ffff9b200000 r-xp 00000000 00:2a 124 /usr/lib64/libssl.so.3.5.8\n"
    "ffff9c000000-ffff9c001000 rw-p 00000000 00:00 0\n"
)


class ReadyTests(unittest.TestCase):
    def test_the_real_server_is_ready(self) -> None:
        self.assertTrue(sc.ready(REAL_SERVER))

    def test_the_temporary_initialisation_server_is_not(self) -> None:
        self.assertFalse(sc.ready(TEMPORARY_SERVER))

    def test_a_log_with_no_ready_line_is_not(self) -> None:
        self.assertFalse(sc.ready("Initializing database\n"))


class VariableTests(unittest.TestCase):
    def test_reads_the_value(self) -> None:
        self.assertEqual(
            sc.variable_value(
                "8.0.46-37\npercona_telemetry_disable\tON\n",
                "percona_telemetry_disable",
            ),
            "ON",
        )

    def test_a_missing_variable_is_none(self) -> None:
        self.assertIsNone(sc.variable_value("8.0.46-37\n", "percona_telemetry_disable"))

    def test_off_is_not_on(self) -> None:
        self.assertEqual(
            sc.variable_value(
                "percona_telemetry_disable\tOFF\n", "percona_telemetry_disable"
            ),
            "OFF",
        )


class LoadedLibraryTests(unittest.TestCase):
    def test_a_clean_map_loads_none(self) -> None:
        self.assertEqual(sc.loaded_libraries(MAPS_CLEAN), [])

    def test_each_reported_library_is_found(self) -> None:
        for library in (
            "libkrb5.so.3.3",
            "libgssapi_krb5.so.2.2",
            "libsqlite3.so.0.8.6",
            "libexpat.so.1.8.10",
            "libmount.so.1.1.0",
            "libblkid.so.1.1.0",
            "libuuid.so.1.3.0",
            "libjson-glib-1.0.so.0.600.6",
        ):
            with self.subTest(library=library):
                maps = (
                    MAPS_CLEAN
                    + f"ffff9d000000-ffff9d100000 r-xp 00000000 00:2a 9 /usr/lib64/{library}\n"
                )
                self.assertNotEqual(sc.loaded_libraries(maps), [], library)

    def test_a_directory_name_is_not_a_library(self) -> None:
        maps = "ffff9a000000-ffff9a1c0000 r-xp 00000000 00:2a 1 /opt/krb5/bin/mysqld\n"
        self.assertEqual(sc.loaded_libraries(maps), [])


class TelemetryTests(unittest.TestCase):
    def test_mysqld_started_with_telemetry_disabled(self) -> None:
        self.assertTrue(sc.telemetry_off("mysqld\0--percona_telemetry_disable=1\0"))

    def test_mysqld_without_the_flag(self) -> None:
        self.assertFalse(sc.telemetry_off("mysqld\0"))

    def test_another_process_with_the_flag(self) -> None:
        self.assertFalse(sc.telemetry_off("sh\0--percona_telemetry_disable=1\0"))

    def test_an_empty_command_line(self) -> None:
        self.assertFalse(sc.telemetry_off(""))


if __name__ == "__main__":
    unittest.main()
