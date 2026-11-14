"""The nightly dump's slot on db1, pinned.

The owner ruled 03:00 for the nightly dump. The hosts run UTC (the unit comments,
the alert text and the drift check all read the clock as UTC), so the pinned value
is 03:00 UTC. The tests also hold the order the other timers rely on: the control
host's worker finishes its slot before the dump starts, and the prune starts after
the longest the dump can run.
"""

import configparser
import datetime
import pathlib
import re
import unittest

PROVISION = pathlib.Path(__file__).resolve().parent
CONTROL = PROVISION.parent.parent / "control" / "provision"

DUMP_TIMER = "branchleft-db-dump.timer"
DUMP_SERVICE = "branchleft-db-dump.service"
PRUNE_TIMER = "branchleft-db-prune.timer"
WORKER_TIMER = "branchleft-backup-worker.timer"

DAILY = re.compile(r"^\*-\*-\* (\d\d):(\d\d):(\d\d)$")


def _unit(path: pathlib.Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str  # type: ignore[assignment]
    parser.read_string(path.read_text())
    return parser


def _daily(path: pathlib.Path) -> datetime.timedelta:
    value = _unit(path)["Timer"]["OnCalendar"]
    match = DAILY.match(value)
    assert match, f"{path.name}: OnCalendar {value!r} is not a plain daily time"
    hours, minutes, seconds = (int(part) for part in match.groups())
    return datetime.timedelta(hours=hours, minutes=minutes, seconds=seconds)


def _seconds(text: str) -> int:
    return int(re.sub(r"\D", "", text))


class DumpTimerSlotTests(unittest.TestCase):
    def test_the_nightly_dump_fires_at_0300(self) -> None:
        self.assertEqual(
            _unit(PROVISION / DUMP_TIMER)["Timer"]["OnCalendar"], "*-*-* 03:00:00"
        )

    def test_the_random_delay_is_five_minutes_so_the_monitoring_thresholds_still_hold(
        self,
    ) -> None:
        self.assertEqual(
            _unit(PROVISION / DUMP_TIMER)["Timer"]["RandomizedDelaySec"], "300"
        )

    def test_a_missed_night_is_caught_up(self) -> None:
        self.assertEqual(_unit(PROVISION / DUMP_TIMER)["Timer"]["Persistent"], "true")

    def test_the_prune_starts_after_the_longest_the_dump_can_run(self) -> None:
        delay = datetime.timedelta(
            seconds=_seconds(
                _unit(PROVISION / DUMP_TIMER)["Timer"]["RandomizedDelaySec"]
            )
        )
        timeout = datetime.timedelta(
            seconds=_seconds(
                _unit(PROVISION / DUMP_SERVICE)["Service"]["TimeoutStartSec"]
            )
        )
        latest_end = _daily(PROVISION / DUMP_TIMER) + delay + timeout
        self.assertLess(latest_end, _daily(PROVISION / PRUNE_TIMER))

    def test_the_control_hosts_worker_slot_is_before_the_dump(self) -> None:
        self.assertLess(_daily(CONTROL / WORKER_TIMER), _daily(PROVISION / DUMP_TIMER))

    def test_no_comment_still_names_the_old_slot(self) -> None:
        for path in (
            PROVISION / DUMP_TIMER,
            PROVISION / PRUNE_TIMER,
            CONTROL / WORKER_TIMER,
            CONTROL / "install_backup_worker.md",
            PROVISION / "dump_nightly.md",
        ):
            self.assertNotIn("03:10", path.read_text(), path.name)


if __name__ == "__main__":
    unittest.main()
