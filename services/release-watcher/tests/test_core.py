import json
import os
import unittest

from release_watcher import core

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
REPO_DOCKERFILE = os.path.join(HERE, "..", "..", "..", "Dockerfile")
ZERO = "sha256:" + "0" * 64


def load(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as handle:
        return json.load(handle)


TAGS = load("dockerhub-ghost-tags-2026-10-10.json")["tags"]
DIGESTS = load("dockerhub-ghost-digests-2026-10-10.json")["digests"]
PINNED_FROM = (
    "FROM ghost:6.55.0-alpine@sha256:de23ea18e09f1f6e94dd323c831c3821494fa054b7a55984a5bd0b817fcab918\n"
)


class RecordingResolver:
    def __init__(self, digests):
        self.digests = digests
        self.calls = []

    def __call__(self, tag):
        self.calls.append(tag)
        return self.digests.get(tag, "sha256:" + "f" * 64)


def pin_at(tag):
    return core.Pin(tag=tag, digest=DIGESTS[tag], version=core.parse_version(tag))


def from_line(tag_version, digest, suffix=""):
    return f"FROM ghost:{tag_version}-alpine@{digest}{suffix}\n"


class TagGuardTests(unittest.TestCase):
    def test_accepts_a_plain_stable_alpine_tag(self):
        self.assertEqual(core.parse_version("6.69.0-alpine"), (6, 69, 0))

    def test_rejects_prereleases_variants_and_other_flavours(self):
        for tag in ["6.69.0-next-alpine", "6.69.0-next-alpine3.23", "6.69.0-alpine3.23",
                    "6.69.0-rc.1-alpine", "6.0.0-rc.2", "6.69.0-bookworm", "6-next-alpine",
                    "6.69-alpine", "7.0.0-next"]:
            with self.subTest(tag=tag):
                self.assertIsNone(core.parse_version(tag))

    def test_rejects_fullwidth_digits_a_trailing_newline_and_long_numbers(self):
        for tag in ["６.69.0-alpine", "6.69.0-alpine\n", "9" * 120 + ".0.0-alpine",
                    "6.69.0000000-alpine", "٦.69.0-alpine"]:
            with self.subTest(tag=tag[:20]):
                self.assertIsNone(core.parse_version(tag))

    def test_stable_versions_keeps_only_matching_tags_from_the_recorded_list(self):
        found = core.stable_versions(TAGS)
        self.assertEqual(found["6.69.0-alpine"], (6, 69, 0))
        self.assertNotIn("6.69.0-next-alpine", found)
        self.assertEqual(max(found.values()), (6, 69, 0))


class PinShapeTests(unittest.TestCase):
    def test_reads_the_pin_from_the_repo_dockerfile(self):
        with open(REPO_DOCKERFILE, encoding="utf-8") as handle:
            pin = core.read_pin(handle.read())
        self.assertEqual(pin.tag, "6.55.0-alpine")

    def test_refuses_a_missing_duplicate_or_multi_stage_dockerfile(self):
        with self.assertRaises(ValueError):
            core.read_pin("FROM node:22\n")
        with self.assertRaises(ValueError):
            core.read_pin(PINNED_FROM + PINNED_FROM)

    def test_refuses_a_second_stage_whose_first_line_has_an_alias(self):
        text = from_line("6.55.0", DIGESTS["6.55.0-alpine"], " AS build") + PINNED_FROM
        with self.assertRaises(ValueError):
            core.read_pin(text)

    def test_refuses_a_lowercase_from_beside_an_uppercase_one(self):
        text = from_line("6.55.0", DIGESTS["6.55.0-alpine"]).lower() + PINNED_FROM
        with self.assertRaises(ValueError):
            core.read_pin(text)

    def test_apply_pin_changes_only_the_from_line(self):
        dockerfile = "# header\n" + PINNED_FROM + "RUN echo kept\n"
        digest = DIGESTS["6.69.0-alpine"]
        updated = core.apply_pin(dockerfile, "6.69.0-alpine", digest)
        self.assertEqual(updated, f"# header\nFROM ghost:6.69.0-alpine@{digest}\nRUN echo kept\n")

    def test_apply_pin_refuses_a_malformed_digest(self):
        with self.assertRaises(ValueError):
            core.apply_pin(PINNED_FROM, "6.69.0-alpine", "sha256:abc")
        with self.assertRaises(ValueError):
            core.apply_pin(PINNED_FROM, "6.69.0-alpine", "sha256:" + "a" * 64 + " AS evil")

    def test_apply_pin_refuses_a_non_stable_tag(self):
        with self.assertRaises(ValueError):
            core.apply_pin(PINNED_FROM, "6.69.0-next-alpine", DIGESTS["6.69.0-alpine"])

    def test_without_from_line_ignores_only_the_pin(self):
        a = "# h\n" + PINNED_FROM + "RUN x\n"
        b = "# h\n" + from_line("6.69.0", DIGESTS["6.69.0-alpine"]) + "RUN x\n"
        self.assertEqual(core.without_from_line(a), core.without_from_line(b))
        self.assertNotEqual(core.without_from_line(a), core.without_from_line("# h\nRUN y\n" + PINNED_FROM))


class DecideTests(unittest.TestCase):
    def test_moves_a_pin_to_the_newest_stable_6x_with_its_digest(self):
        decision = core.decide(pin_at("6.55.0-alpine"), TAGS, RecordingResolver(DIGESTS))
        self.assertEqual(decision.pr_tag, "6.69.0-alpine")
        self.assertEqual(decision.pr_digest, DIGESTS["6.69.0-alpine"])
        self.assertIsNone(decision.notify_major)

    def test_only_the_chosen_stable_tag_is_resolved_never_a_prerelease(self):
        resolver = RecordingResolver(DIGESTS)
        core.decide(pin_at("6.55.0-alpine"), TAGS, resolver)
        self.assertEqual(resolver.calls, ["6.69.0-alpine"])

    def test_no_pr_when_the_pin_already_matches_the_newest_digest(self):
        decision = core.decide(pin_at("6.69.0-alpine"), TAGS, RecordingResolver(DIGESTS))
        self.assertIsNone(decision.pr_tag)

    def test_pr_when_the_same_tag_has_a_different_digest(self):
        drifted = core.Pin(tag="6.69.0-alpine", digest=ZERO, version=(6, 69, 0))
        decision = core.decide(drifted, TAGS, RecordingResolver(DIGESTS))
        self.assertEqual(decision.pr_tag, "6.69.0-alpine")

    def test_a_new_major_is_noticed_and_never_followed(self):
        decision = core.decide(
            pin_at("6.69.0-alpine"), TAGS + ["7.0.0-alpine"], RecordingResolver(DIGESTS)
        )
        self.assertEqual(decision.notify_major, 7)
        self.assertIsNone(decision.pr_tag)

    def test_a_new_major_is_never_chosen_as_the_pr_target(self):
        resolver = RecordingResolver(DIGESTS)
        decision = core.decide(pin_at("6.55.0-alpine"), TAGS + ["7.0.0-alpine"], resolver)
        self.assertEqual(decision.pr_tag, "6.69.0-alpine")
        self.assertNotIn("7.0.0-alpine", resolver.calls)

    def test_a_major_seen_only_as_prerelease_is_not_noticed(self):
        tags = TAGS + ["7.0.0-next-alpine", "7.0.0-rc.1-alpine", "7.0.0-next"]
        decision = core.decide(pin_at("6.69.0-alpine"), tags, RecordingResolver(DIGESTS))
        self.assertIsNone(decision.notify_major)

    def test_a_next_tag_beside_a_newer_stable_is_not_chosen(self):
        decision = core.decide(
            pin_at("6.55.0-alpine"), TAGS + ["6.70.0-next-alpine"], RecordingResolver(DIGESTS)
        )
        self.assertEqual(decision.pr_tag, "6.69.0-alpine")

    def test_no_pr_when_the_pin_is_ahead_of_the_registry_line(self):
        ahead = core.Pin(tag="6.70.0-alpine", digest=DIGESTS["6.69.0-alpine"], version=(6, 70, 0))
        resolver = RecordingResolver(DIGESTS)
        decision = core.decide(ahead, TAGS, resolver)
        self.assertIsNone(decision.pr_tag)
        self.assertEqual(resolver.calls, [])

    def test_a_malformed_digest_from_the_registry_is_refused(self):
        for bad in ["sha256:abc", "not-a-digest", "", "sha256:" + "A" * 64]:
            with self.subTest(bad=bad[:20]):
                with self.assertRaises(ValueError):
                    core.decide(pin_at("6.55.0-alpine"), TAGS, lambda tag, b=bad: b)

    def test_an_empty_registry_is_an_error_not_a_quiet_no_op(self):
        with self.assertRaises(ValueError):
            core.decide(pin_at("6.55.0-alpine"), ["latest"], RecordingResolver(DIGESTS))


class AgeMetricTests(unittest.TestCase):
    def test_renders_the_last_success_timestamp_as_a_gauge(self):
        text = core.render_age_metric(1760000000.9)
        self.assertIn("ghost_release_watcher_last_success_timestamp_seconds 1760000000\n", text)
        self.assertIn("# TYPE ghost_release_watcher_last_success_timestamp_seconds gauge", text)


if __name__ == "__main__":
    unittest.main()
