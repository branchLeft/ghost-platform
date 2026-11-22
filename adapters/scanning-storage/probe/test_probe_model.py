"""The probe's pure parts. Run: python3 -m unittest discover -s adapters/scanning-storage/probe"""

from __future__ import annotations

import json
import unittest

import probe_model as m


def export(**tables: list[m.Json]) -> m.Json:
    return {"db": [{"meta": {}, "data": dict(tables)}]}


class ClassifyTest(unittest.TestCase):
    def test_each_class(self) -> None:
        media = f"{m.MEDIA_ADDRESS}/{m.TENANT_PREFIX}/content/images/a.png"
        token = f"{m.PLACEHOLDER}/content/images/a.png"
        self.assertEqual(m.classify(media), m.REWRITTEN)
        self.assertEqual(m.classify(token, token), m.UNTOUCHED)
        self.assertEqual(m.classify(token, f"{m.PLACEHOLDER}/content/images/b.png"), m.RENAMED)
        self.assertEqual(m.classify(f"http://{m.DEMO_HOST}:2368/x"), m.LEFT_DEMO)
        self.assertEqual(m.classify(f"{m.PLACEHOLDER}/about/"), m.PLACEHOLDER_OTHER)
        self.assertEqual(m.classify(None), m.ABSENT)
        self.assertTrue(m.classify("https://elsewhere.test/a").startswith("other: "))

    def test_a_media_address_without_the_tenant_prefix_is_not_rewritten(self) -> None:
        self.assertTrue(m.classify(f"{m.MEDIA_ADDRESS}/t-other/a.png").startswith("other: "))


class ReferenceTest(unittest.TestCase):
    def test_addresses_stop_at_quotes_and_keep_spaces(self) -> None:
        text = r'{"src":"__GHOST_URL__/content/images/my photo (1).JPG","u":"https://a.test/x"}'
        self.assertEqual(
            m.addresses(text),
            ["__GHOST_URL__/content/images/my photo (1).JPG", "https://a.test/x"],
        )

    def test_a_marker_is_a_regular_expression(self) -> None:
        text = (
            '<img src="__GHOST_URL__/content/images/a-lex-image-x.png"><a href="https://demo.x/y">'
        )
        self.assertEqual(
            m.find_reference(text, "lex-image"), "__GHOST_URL__/content/images/a-lex-image-x.png"
        )
        self.assertEqual(m.find_reference(text, r"^https://demo"), "https://demo.x/y")
        self.assertIsNone(m.find_reference(text, "absent"))
        self.assertIsNone(m.find_reference(None, None))

    def test_storage_key_follows_the_redirect_of_a_site_relative_path(self) -> None:
        self.assertEqual(
            m.storage_key(f"{m.MEDIA_ADDRESS}/t/content/images/a.png"), "t/content/images/a.png"
        )
        self.assertEqual(
            m.storage_key(f"{m.PLACEHOLDER}/content/images/a.png"),
            f"{m.TENANT_PREFIX}/content/images/a.png",
        )
        self.assertIsNone(m.storage_key("https://elsewhere.test/a.png"))


class MeasureTest(unittest.TestCase):
    def test_a_field_is_found_in_the_row_it_names_and_reported_absent_when_gone(self) -> None:
        feature = f"{m.PLACEHOLDER}/content/images/post-feature-x.png"
        post: m.Json = {"id": "p1", "title": m.MAIN_TITLE, "feature_image": feature}
        tenant = export(posts=[post], settings=[], posts_meta=[], tags=[], users=[], newsletters=[])
        rows = {r.item: r for r in m.measure_references(tenant, tenant, set())}
        self.assertEqual(rows["post feature_image"].result, m.UNTOUCHED)
        self.assertEqual(rows["post feature_image"].extra, "NO OBJECT THERE")
        self.assertEqual(rows["tag feature_image"].result, m.ABSENT)

    def test_a_stored_object_is_reported_there(self) -> None:
        ref = f"{m.PLACEHOLDER}/content/images/post-feature-x.png"
        post: m.Json = {"id": "p1", "title": m.MAIN_TITLE, "feature_image": ref}
        tenant = export(posts=[post], settings=[], posts_meta=[], tags=[], users=[], newsletters=[])
        key = f"{m.TENANT_PREFIX}/content/images/post-feature-x.png"
        rows = {r.item: r for r in m.measure_references(tenant, tenant, {key})}
        self.assertEqual(rows["post feature_image"].extra, "object there")

    def test_settings_kept_dropped_or_not_told_apart(self) -> None:
        def settings(**kv: str) -> m.Json:
            return export(settings=[{"key": k, "value": v} for k, v in kv.items()])

        rows = {
            r.item: r.result
            for r in m.measure_settings(
                settings(title="d", locale="en"),
                settings(title="t", locale="en"),
                settings(title="d", locale="en"),
            )
        }
        self.assertEqual(rows["setting title"], "kept (the demo's value)")
        self.assertEqual(rows["setting locale"], "same on both sides, so not told apart")
        dropped = m.measure_settings(settings(title="d"), settings(title="t"), settings(title="t"))
        self.assertEqual(dropped[0].result, "dropped (the tenant keeps its own)")


class StaffTest(unittest.TestCase):
    def test_the_zip_gets_three_staff_users_and_a_regex_named_reference(self) -> None:
        data: m.Json = {
            "users": [{"id": "u1", "slug": "owner", "email": "o@x.test", "name": "Owner"}],
            "roles": [{"id": f"r{i}", "name": n} for i, (_, n) in enumerate(m.STAFF)],
            "roles_users": [],
            "posts": [
                {"id": "p1", "title": m.MAIN_TITLE},
                {"id": "p2", "title": m.REGEX_TITLE},
            ],
            "posts_authors": [{"id": "a", "post_id": "p2", "author_id": "u1", "sort_order": 0}],
        }
        doc: m.Json = {"db": [{"meta": {}, "data": data}]}
        m.add_staff_and_regex_name(doc)
        self.assertEqual(len(m.as_list(data["users"])), 4)
        self.assertEqual(len(m.as_list(data["roles_users"])), 3)
        regex_post = m.as_obj(m.as_list(data["posts"])[1])
        self.assertIn(m.REGEX_NAME, m.as_str(regex_post["feature_image"]))
        self.assertIn(m.REGEX_NAME, m.as_str(regex_post["html"]))
        links = [m.as_obj(link) for link in m.as_list(data["posts_authors"])]
        self.assertNotEqual(links[0]["author_id"], "u1")
        self.assertEqual(len(links), 2)
        json.dumps(doc)


class FixtureTest(unittest.TestCase):
    def test_images_are_distinct_valid_pngs(self) -> None:
        self.assertNotEqual(m.tiny_png(1), m.tiny_png(2))
        self.assertTrue(m.tiny_png(1).startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertIn(b"ftyp", m.mp4_bytes())
        self.assertTrue(m.pdf_bytes().startswith(b"%PDF-"))

    def test_table_pads_to_the_widest_cell(self) -> None:
        out = m.table(["a", "bb"], [["xxx", "y"]]).splitlines()
        self.assertEqual(len({len(line) for line in out}), 1)


if __name__ == "__main__":
    unittest.main()


class RewriteTest(unittest.TestCase):
    def demo(self) -> m.Json:
        image = f"{m.PLACEHOLDER}/content/images/2026/11/probe-lex-image.png"
        og = f"{m.PLACEHOLDER}/content/images/2026/11/probe-post-og.png"
        return export(
            users=[{"id": "demo-owner", "slug": "owner"}],
            roles_users=[{"user_id": "demo-owner", "role_id": "r"}],
            posts=[
                {"id": "p1", "title": "Probe post", "lexical": f'{{"src":"{image}"}}',
                 "og_image": og, "created_by": "demo-owner"},
            ],
            posts_authors=[{"post_id": "p1", "author_id": "demo-owner"}],
            settings=[
                {"key": "codeinjection_head", "value": "x"},
                {"key": "og_image", "value": og},
                {"key": "title", "value": f"see {image}"},
            ],
        )

    def replacements(self) -> dict[str, str]:
        return {f"{m.PLACEHOLDER}/content/images/2026/11/probe-lex-image.png": "https://media/t/a.png",
                f"{m.PLACEHOLDER}/content/images/2026/11/probe-post-og.png": "https://media/t/og.png"}

    def test_references_replaced_and_users_removed(self) -> None:
        out = m.rewrite_export(self.demo(), self.replacements(), "tenant-owner")
        text = json.dumps(out)
        self.assertNotIn("__GHOST_URL__", text)
        data = m.as_obj(m.dig(out, "db", 0, "data"))
        self.assertNotIn("users", data)
        self.assertEqual(data["roles_users"], [])
        self.assertEqual(m.rows_of(out, "posts")[0]["created_by"], "tenant-owner")
        self.assertEqual(m.rows_of(out, "posts_authors")[0]["author_id"], "tenant-owner")

    def test_tenant_owned_settings_dropped(self) -> None:
        keys = [r["key"] for r in m.rows_of(m.rewrite_export(self.demo(), {}, "o"), "settings")]
        for key in m.TENANT_OWNED_SETTINGS:
            self.assertNotIn(key, keys)
        self.assertEqual(len(m.TENANT_OWNED_SETTINGS), 6)
        self.assertIn("title", keys)

    def test_skip_leaves_og_image_as_in_the_demo(self) -> None:
        out = m.rewrite_export(self.demo(), self.replacements(), "o", frozenset({"og_image"}))
        self.assertIn("__GHOST_URL__/content/images/2026/11/probe-post-og.png",
                      m.as_str(m.rows_of(out, "posts")[0]["og_image"]))
        settings = {r["key"]: r["value"] for r in m.rows_of(out, "settings")}
        self.assertIn("__GHOST_URL__", m.as_str(settings["og_image"]))
        self.assertNotIn("__GHOST_URL__", m.as_str(settings["title"]))

    def test_posts_on_removed_users_found_before_rewrite(self) -> None:
        self.assertEqual(m.posts_by_removed_users(self.demo(), {"demo-owner"}), ["Probe post"])
        self.assertEqual(m.posts_by_removed_users(self.demo(), {"someone-else"}), [])

    def test_is_file_field_excludes_page_links_and_regex_rows(self) -> None:
        self.assertTrue(m.is_file_field("post og_image"))
        self.assertFalse(m.is_file_field("setting navigation (link to the demo's own page)"))
        self.assertFalse(m.is_file_field("regex name: post html"))
        self.assertFalse(m.is_file_field("author profile_image"))

    def test_demo_forms_cover_three_spellings(self) -> None:
        self.assertEqual(len(m.demo_forms("images/a.png")), 3)
