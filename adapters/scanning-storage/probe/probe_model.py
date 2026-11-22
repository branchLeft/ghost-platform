"""The probe's pure parts: what a reference looks like, which field classes it
can sit in, how an export is searched and how the report is laid out.
See ghost_import_probe.md."""

from __future__ import annotations

import dataclasses
import json
import re
import secrets
import struct
import zlib
from typing import Iterable, Sequence, cast

DEMO_SITE = "http://demo.ghost.test:2368"
DEMO_HOST = "demo.ghost.test"
TENANT_SITE = "http://tenant.ghost.test:2368"
MEDIA_ADDRESS = "https://media.probe.test"
TENANT_PREFIX = "t-probe0123456789abcdefgh"
PLACEHOLDER = "__GHOST_URL__"

REWRITTEN = "rewritten to the media address plus prefix"
RENAMED = "site-relative __GHOST_URL__/content/, name replaced"
UNTOUCHED = "site-relative __GHOST_URL__/content/, as in the demo"
LEFT_DEMO = "left naming the demo's hostname"
PLACEHOLDER_OTHER = "__GHOST_URL__ (not a content path)"
ABSENT = "absent from the tenant's data"

MAIN_TITLE = "Probe post"
REGEX_TITLE = "Probe post with a regular-expression file name"
REGEX_NAME = "my photo (1).JPG"
PAGE_PATH = "/about/"

Json = dict[str, object]


class ProbeError(RuntimeError):
    """The probe could not stand, as opposed to a finding about Ghost."""


def as_obj(value: object) -> Json:
    if not isinstance(value, dict):
        raise ProbeError(f"expected an object, got {type(value).__name__}")
    return cast(Json, value)


def as_list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ProbeError(f"expected a list, got {type(value).__name__}")
    return cast(list[object], value)


def as_str(value: object) -> str:
    if not isinstance(value, str):
        raise ProbeError(f"expected a string, got {type(value).__name__}")
    return value


def dig(value: object, *path: str | int) -> object:
    """Walk an object by keys and indexes; a wrong shape is a ProbeError."""
    for step in path:
        if isinstance(step, int):
            value = as_list(value)[step]
        else:
            value = as_obj(value)[step]
    return value


def classify(reference: str | None, demo_reference: str | None = None) -> str:
    """Which result class a reference found in the tenant's data is in."""
    if reference is None:
        return ABSENT
    if reference.startswith(f"{MEDIA_ADDRESS}/{TENANT_PREFIX}/"):
        return REWRITTEN
    if reference.startswith(f"{PLACEHOLDER}/content/"):
        return UNTOUCHED if reference == demo_reference else RENAMED
    if DEMO_HOST in reference:
        return LEFT_DEMO
    if reference.startswith(PLACEHOLDER):
        return PLACEHOLDER_OTHER
    return f"other: {reference}"


# An address runs to the next quote, angle bracket or backslash; spaces stay in,
# so a file name with one is not cut short.
_ADDRESS = re.compile(r"(?:https?://|__GHOST_URL__)[^\"'<>\\]*")


def addresses(text: str) -> list[str]:
    return [m.group(0).rstrip() for m in _ADDRESS.finditer(text)]


def find_reference(text: str | None, marker: str | None) -> str | None:
    """The first address in `text` that matches the regular expression `marker`, or any."""
    if not text:
        return None
    for found in addresses(text):
        if marker is None or re.search(marker, found):
            return found
    return None


def storage_key(reference: str) -> str | None:
    """The storage key a reference reaches: direct at the media address, or through
    the adapter's redirect from a site-relative content path."""
    prefix = f"{MEDIA_ADDRESS}/"
    if reference.startswith(prefix):
        return reference[len(prefix) :]
    if reference.startswith(f"{PLACEHOLDER}/content/"):
        return f"{TENANT_PREFIX}/{reference[len(PLACEHOLDER) + 1 :]}"
    return None


@dataclasses.dataclass(frozen=True)
class FieldClass:
    """One place a reference can sit, and how to find it in an export.

    `marker` is the file stem the reference holds (None: any address in the
    field). A post is found by title, a settings row by key.
    """

    name: str
    table: str
    column: str
    marker: str | None
    post_title: str | None = None
    key: str | None = None


def _lexical(name: str, marker: str) -> FieldClass:
    return FieldClass(name, "posts", "lexical", marker, post_title=MAIN_TITLE)


def _html(name: str, marker: str) -> FieldClass:
    return FieldClass(name, "posts", "html", marker, post_title=MAIN_TITLE)


def _setting(name: str, key: str, marker: str) -> FieldClass:
    return FieldClass(name, "settings", "value", marker, key=key)


def field_classes() -> list[FieldClass]:
    return [
        _lexical("post lexical: image card", "lex-image"),
        _lexical("post lexical: gallery card, first image", "lex-gallery-a"),
        _lexical("post lexical: gallery card, second image", "lex-gallery-b"),
        _lexical("post lexical: file card", "probe-report"),
        _lexical("post lexical: video card (media file)", "probe-clip"),
        _lexical("post lexical: video card thumbnail", "lex-video-thumb"),
        _lexical("post lexical: bookmark card icon", "lex-bookmark-icon"),
        _lexical("post lexical: bookmark card thumbnail", "lex-bookmark-thumb"),
        _lexical("post lexical: html card image", "lex-html-card"),
        _lexical("post lexical: link to an uploaded image", "lex-link"),
        _lexical(
            "post lexical: link to the demo's own page",
            r"^(__GHOST_URL__|http://demo\.ghost\.test:2368)/about/",
        ),
        _lexical(
            "post lexical: html card link, another spelling of the demo host", r"^https://demo"
        ),
        _html("post html (rendered): image card", "lex-image"),
        _html("post html (rendered): file card", "probe-report"),
        _html("post html (rendered): video card", "probe-clip"),
        _html("post html (rendered): gallery image", "lex-gallery-a"),
        FieldClass("post feature_image", "posts", "feature_image", "post-feature", MAIN_TITLE),
        FieldClass("post og_image", "posts_meta", "og_image", "post-og", MAIN_TITLE),
        FieldClass("post twitter_image", "posts_meta", "twitter_image", "post-twitter", MAIN_TITLE),
        FieldClass("tag feature_image", "tags", "feature_image", "tag-feature"),
        FieldClass("tag og_image", "tags", "og_image", "tag-og"),
        FieldClass("tag twitter_image", "tags", "twitter_image", "tag-twitter"),
        FieldClass("author profile_image", "users", "profile_image", "author-profile"),
        FieldClass("author cover_image", "users", "cover_image", "author-cover"),
        _setting("setting logo", "logo", "site-logo"),
        _setting("setting icon", "icon", "site-icon"),
        _setting("setting cover_image", "cover_image", "site-cover"),
        _setting("setting og_image", "og_image", "site-og"),
        _setting("setting twitter_image", "twitter_image", "site-twitter"),
        _setting("setting navigation (link to the demo's own page)", "navigation", "/about/"),
        FieldClass("newsletter header_image", "newsletters", "header_image", "newsletter-header"),
        FieldClass("regex name: post feature_image", "posts", "feature_image", None, REGEX_TITLE),
        FieldClass("regex name: post html", "posts", "html", None, REGEX_TITLE),
        FieldClass("regex name: post lexical", "posts", "lexical", None, REGEX_TITLE),
    ]


def rows_of(export: Json, table: str) -> list[Json]:
    data = as_obj(dig(export, "db", 0, "data"))
    raw = data.get(table)
    return [as_obj(r) for r in as_list(raw)] if raw else []


def locate_all(export: Json, field: FieldClass) -> list[str]:
    """The text in the field's column, for every row the field can be in."""
    rows = rows_of(export, field.table)
    if field.post_title is not None:
        posts = [p for p in rows_of(export, "posts") if p.get("title") == field.post_title]
        ids = {p.get("id") for p in posts}
        rows = posts if field.table == "posts" else [r for r in rows if r.get("post_id") in ids]
    if field.key is not None:
        rows = [r for r in rows if r.get("key") == field.key]
    values = [r.get(field.column) for r in rows]
    return [v for v in values if isinstance(v, str)]


def locate(export: Json, field: FieldClass) -> str | None:
    """The first address in the field that matches its marker, or None."""
    for text in locate_all(export, field):
        found = find_reference(text, field.marker)
        if found is not None:
            return found
    return None


@dataclasses.dataclass(frozen=True)
class Row:
    item: str
    result: str
    detail: str = ""
    extra: str = ""


def measure_references(demo: Json, tenant: Json, stored_keys: set[str]) -> list[Row]:
    rows: list[Row] = []
    for field in field_classes():
        reference = locate(tenant, field)
        key = storage_key(reference) if reference else None
        stored = (
            "" if key is None else ("object there" if key in stored_keys else "NO OBJECT THERE")
        )
        rows.append(
            Row(field.name, classify(reference, locate(demo, field)), reference or "", stored)
        )
    return rows


SETTING_KEYS = (
    "title",
    "description",
    "navigation",
    "codeinjection_head",
    "codeinjection_foot",
    "accent_color",
    "locale",
    "timezone",
    "meta_title",
    "og_title",
    "active_theme",
)


def setting_value(export: Json, key: str) -> str | None:
    for row in rows_of(export, "settings"):
        if row.get("key") == key:
            value = row.get("value")
            return value if isinstance(value, str) else None
    return None


def measure_settings(demo: Json, tenant_before: Json, tenant_after: Json) -> list[Row]:
    rows: list[Row] = []
    for key in SETTING_KEYS:
        theirs = setting_value(demo, key)
        before = setting_value(tenant_before, key)
        after = setting_value(tenant_after, key)
        if after == theirs and theirs != before:
            result = "kept (the demo's value)"
        elif after == before and theirs == before:
            result = "same on both sides, so not told apart"
        elif after == before:
            result = "dropped (the tenant keeps its own)"
        else:
            result = "changed to a value that is neither"
        rows.append(
            Row(f"setting {key}", result, f"demo={theirs!r} before={before!r} after={after!r}")
        )
    return rows


def object_id() -> str:
    return secrets.token_hex(12)


def lexical_root(children: Sequence[object]) -> str:
    return json.dumps(
        {
            "root": {
                "children": list(children),
                "direction": None,
                "format": "",
                "indent": 0,
                "type": "root",
                "version": 1,
            }
        }
    )


def image_card(src: str) -> Json:
    return {
        "type": "image",
        "version": 1,
        "src": src,
        "width": 2,
        "height": 2,
        "alt": "",
        "caption": "",
        "cardWidth": "regular",
        "href": "",
    }


def paragraph_link(url: str, text: str) -> Json:
    leaf = {
        "detail": 0,
        "format": 0,
        "mode": "normal",
        "style": "",
        "text": text,
        "type": "extended-text",
        "version": 1,
    }
    link = {
        "children": [leaf],
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "link",
        "version": 1,
        "rel": None,
        "target": None,
        "title": None,
        "url": url,
    }
    return {
        "children": [link],
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "paragraph",
        "version": 1,
    }


STAFF = (("probe-admin", "Administrator"), ("probe-editor", "Editor"), ("probe-author", "Author"))


def add_staff_and_regex_name(export: Json) -> None:
    """Add what a demo cannot be made to hold, in place: three more staff users,
    a post authored by an editor, a second author on the main post, and a
    reference to a file whose name has regular-expression characters."""
    data = as_obj(dig(export, "db", 0, "data"))
    users = [as_obj(u) for u in as_list(data["users"])]
    roles = {as_str(as_obj(r)["name"]): as_str(as_obj(r)["id"]) for r in as_list(data["roles"])}
    owner = next(u for u in users if u.get("email") and u.get("slug") != "ghost")
    created: dict[str, str] = {}
    roles_users = as_list(data["roles_users"])
    for slug, role in STAFF:
        user: Json = dict(owner)
        user |= {
            "id": object_id(),
            "name": slug,
            "slug": slug,
            "email": f"{slug}@example.test",
            "profile_image": None,
            "cover_image": None,
        }
        as_list(data["users"]).append(user)
        roles_users.append({"id": object_id(), "role_id": roles[role], "user_id": user["id"]})
        created[slug] = as_str(user["id"])
    posts = [as_obj(p) for p in as_list(data["posts"])]
    regex_post = next(p for p in posts if p["title"] == REGEX_TITLE)
    main_post = next(p for p in posts if p["title"] == MAIN_TITLE)
    ref = f"{PLACEHOLDER}/content/images/2026/11/{REGEX_NAME}"
    regex_post["feature_image"] = ref
    regex_post["html"] = f'<p><img src="{ref}" alt=""></p>'
    regex_post["lexical"] = lexical_root([image_card(ref)])
    links = as_list(data["posts_authors"])
    for link in links:
        item = as_obj(link)
        if item["post_id"] == regex_post["id"]:
            item["author_id"] = created["probe-editor"]
    links.append(
        {
            "id": object_id(),
            "post_id": main_post["id"],
            "author_id": created["probe-author"],
            "sort_order": 1,
        }
    )


def tiny_png(seed: int) -> bytes:
    """A distinct valid 2x2 PNG, so no two probe images share a hash."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    rows = b"".join(
        bytes([0, seed % 256, (seed // 256 + row * 40) % 256, 90, seed % 256, 20, 60])
        for row in (0, 1)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def mp4_bytes() -> bytes:
    """A tiny file the decorator's media detector reads as a video."""
    ftyp = _box(b"ftyp", b"isom" + struct.pack(">I", 0) + b"isom" + b"mp42")
    hdlr = _box(b"hdlr", struct.pack(">II", 0, 0) + b"vide" + bytes(12))
    moov = _box(b"moov", _box(b"trak", _box(b"mdia", hdlr)))
    return ftyp + moov + _box(b"mdat", bytes([0x5A]) * 32)


def pdf_bytes() -> bytes:
    return b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"


def table(headers: Sequence[str], rows: Iterable[Sequence[str]]) -> str:
    body = [list(r) for r in rows]
    widths = [max([len(h), *(len(r[i]) for r in body)]) for i, h in enumerate(headers)]

    def line(cells: Sequence[str]) -> str:
        return "| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(cells)) + " |"

    rule = "|-" + "-|-".join("-" * w for w in widths) + "-|"
    return "\n".join([line(headers), rule, *(line(r) for r in body)])


# ------------------------------------------------------------------ mode 2: rewrite

# The six keys issue branchLeft/workspace#3904 names: the tenant's own, never the demo's.
TENANT_OWNED_SETTINGS = (
    "codeinjection_head",
    "codeinjection_foot",
    "accent_color",
    "active_theme",
    "locale",
    "timezone",
)
NON_FILE_FIELDS = (
    "post lexical: link to the demo's own page",
    "post lexical: html card link, another spelling of the demo host",
    "setting navigation (link to the demo's own page)",
)


# The demo's owner is removed by the rewrite, so the images on that user are not carried.
REMOVED_WITH_USERS = ("author profile_image", "author cover_image")


def is_file_field(name: str) -> bool:
    """A field that holds a reference to an uploaded file, not a page link, a regex-name
    row, or an image on the demo's removed owner."""
    return (
        not name.startswith("regex name")
        and name not in NON_FILE_FIELDS
        and name not in REMOVED_WITH_USERS
    )


def demo_forms(rel: str) -> list[str]:
    """The spellings the demo's export holds a content path in."""
    return [
        f"{PLACEHOLDER}/content/{rel}",
        f"{DEMO_SITE}/content/{rel}",
        f"https://{DEMO_HOST}/content/{rel}",
    ]


def removed_user_ids(export: Json) -> set[str]:
    return {as_str(u.get("id")) for u in rows_of(export, "users")}


def posts_by_removed_users(export: Json, removed: set[str]) -> list[str]:
    """Titles of the posts that have at least one author the rewrite removes."""
    ids = {as_str(post.get("id")) for post in rows_of(export, "posts")}
    titles: list[str] = []
    linked = {
        as_str(row.get("post_id"))
        for row in rows_of(export, "posts_authors")
        if row.get("author_id") in removed
    }
    for post in rows_of(export, "posts"):
        if as_str(post.get("id")) in linked and as_str(post.get("id")) in ids:
            titles.append(as_str(post.get("title")))
    return titles


def _rewrite(
    value: object, pairs: Sequence[tuple[str, str]], skip: frozenset[str], field: str | None
) -> object:
    if isinstance(value, str):
        if field in skip:
            return value
        text: str = value
        for form, url in pairs:
            text = text.replace(form, url)
        return text
    if isinstance(value, dict):
        row = cast(Json, value)
        named = row.get("key")
        out: Json = {}
        for key, item in row.items():
            name = named if key == "value" and isinstance(named, str) else key
            out[key] = _rewrite(item, pairs, skip, name)
        return out
    if isinstance(value, list):
        return [_rewrite(item, pairs, skip, field) for item in cast(list[object], value)]
    return value


def rewrite_export(
    export: Json,
    replacements: dict[str, str],
    owner_id: str,
    skip: frozenset[str] = frozenset(),
) -> Json:
    """The demo's export, rewritten for a JSON-only import into the tenant.

    Every demo spelling of a content path becomes the URL the tenant answered
    for that file. The demo's users go, every post and author link points at the
    tenant's owner, and the settings the tenant owns are dropped. `skip` names
    fields left as in the demo: the sabotage that must turn the table red.
    """
    pairs = sorted(replacements.items(), key=lambda pair: len(pair[0]), reverse=True)
    rewritten = cast(Json, json.loads(json.dumps(export)))
    data = as_obj(dig(rewritten, "db", 0, "data"))
    removed = {as_str(as_obj(u).get("id")) for u in as_list(data.pop("users", []))}
    for table in ("roles_users", "permissions_users"):
        if table in data:
            data[table] = [
                r for r in as_list(data[table]) if as_obj(r).get("user_id") not in removed
            ]
    for item in as_list(data.get("posts", [])):
        post = as_obj(item)
        for column in ("created_by", "updated_by"):
            if post.get(column) in removed:
                post[column] = owner_id
    seen: set[object] = set()
    authors: list[object] = []
    for item in as_list(data.get("posts_authors", [])):
        link = as_obj(item)
        link["author_id"] = owner_id
        marker = link.get("post_id")
        if marker not in seen:
            seen.add(marker)
            authors.append(link)
    if "posts_authors" in data:
        data["posts_authors"] = authors
    data["settings"] = [
        r for r in as_list(data.get("settings", [])) if as_obj(r).get("key") not in TENANT_OWNED_SETTINGS
    ]
    return cast(Json, _rewrite(rewritten, pairs, skip, None))
