#!/usr/bin/env python3
"""Probe Ghost's own zip import against the built image; see ghost_import_probe.md.

Usage: ghost_import_probe.py --image IMAGE [--max-zip-mib N] [--report FILE]
                             [--sabotage empty-control-list]
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import http.client
import io
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from collections.abc import Sequence
from pathlib import Path

from probe_model import (
    DEMO_HOST,
    DEMO_SITE,
    MAIN_TITLE,
    MEDIA_ADDRESS,
    PAGE_PATH,
    REGEX_NAME,
    REGEX_TITLE,
    STAFF,
    TENANT_PREFIX,
    TENANT_SITE,
    Json,
    ProbeError,
    Row,
    add_staff_and_regex_name,
    as_list,
    as_obj,
    as_str,
    dig,
    image_card,
    lexical_root,
    measure_references,
    measure_settings,
    mp4_bytes,
    object_id,
    paragraph_link,
    pdf_bytes,
    rows_of,
    table,
    tiny_png,
)

DOUBLE_SCRIPT = (
    Path(__file__).resolve().parent.parent / "test" / "helpers" / "recording-s3-double.cjs"
)
COMPONENT = "ghost-import-probe"
BUCKET = "recording-double"
BOOT_DEADLINE_S = 150
JOB_DEADLINE_S = 240

IMAGE_STEMS = (
    "lex-image",
    "lex-gallery-a",
    "lex-gallery-b",
    "lex-bookmark-icon",
    "lex-bookmark-thumb",
    "lex-video-thumb",
    "lex-html-card",
    "lex-link",
    "post-feature",
    "post-og",
    "post-twitter",
    "tag-feature",
    "tag-og",
    "tag-twitter",
    "author-profile",
    "author-cover",
    "site-logo",
    "site-icon",
    "site-cover",
    "site-og",
    "site-twitter",
    "newsletter-header",
)


# ------------------------------------------------------------------ docker


def docker(*args: str, timeout: float = 120) -> str:
    done = subprocess.run(  # noqa: S603 - argv list, never a shell; args are the probe's own
        ["docker", *args],  # noqa: S607 - docker is resolved from PATH, as everywhere in CI
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if done.returncode != 0:
        raise ProbeError(f"docker {' '.join(args[:2])} failed: {done.stderr.strip()}")
    return done.stdout


def docker_quiet(*args: str) -> str:
    done = subprocess.run(  # noqa: S603 - as above
        ["docker", *args],  # noqa: S607
        capture_output=True,
        text=True,
        check=False,
    )
    return done.stdout + done.stderr


class Resources:
    """The containers and network of one run, all labelled so leftovers are attributable."""

    def __init__(self) -> None:
        self.run_id = uuid.uuid4().hex[:10]
        self.network = f"import-probe-net-{self.run_id}"
        self.containers: list[str] = []

    def label_args(self) -> list[str]:
        return [
            "--label",
            f"branchleft.component={COMPONENT}",
            "--label",
            f"branchleft.run={self.run_id}",
        ]

    def create_network(self) -> None:
        docker("network", "create", *self.label_args(), self.network)

    def remove(self, name: str) -> None:
        docker_quiet("rm", "-f", "-v", name)
        if name in self.containers:
            self.containers.remove(name)

    def cleanup(self) -> list[str]:
        """Remove everything this run made; return what is still there."""
        for name in list(self.containers):
            self.remove(name)
        docker_quiet("network", "rm", self.network)
        flt = f"label=branchleft.run={self.run_id}"
        left: list[str] = []
        for noun, fmt in (
            (["ps", "-a"], "{{.Names}}"),
            (["network", "ls"], "{{.Name}}"),
            (["volume", "ls"], "{{.Name}}"),
        ):
            out = docker_quiet(*noun, "--filter", flt, "--format", fmt)
            left += [f"{noun[0]}: {n}" for n in out.split() if n]
        return left


def start_container(
    res: Resources,
    name: str,
    image: str,
    env: dict[str, str],
    *,
    container_port: int,
    entrypoint: str | None = None,
    command: Sequence[str] = (),
    mounts: Sequence[str] = (),
    add_hosts: Sequence[str] = (),
) -> int:
    args = ["run", "-d", "--name", name, *res.label_args(), "--network", res.network]
    args += ["-p", f"127.0.0.1::{container_port}"]
    for key, value in env.items():
        args += ["-e", f"{key}={value}"]
    for mount in mounts:
        args += ["-v", mount]
    for host in add_hosts:
        args += ["--add-host", host]
    if entrypoint:
        args += ["--entrypoint", entrypoint]
    docker(*args, image, *command)
    res.containers.append(name)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        out = docker_quiet("port", name, f"{container_port}/tcp")
        if out.strip().startswith("127.0.0.1:"):
            return int(out.strip().splitlines()[0].rsplit(":", 1)[1])
        time.sleep(0.5)
    state = docker_quiet("ps", "-a", "--filter", f"name={name}", "--format", "{{.Status}}")
    raise ProbeError(
        f"{name} published no port ({state.strip()}):\n{docker_quiet('logs', name)[-3000:]}"
    )


# ------------------------------------------------------------------ http


@dataclasses.dataclass
class Reply:
    status: int
    body: bytes
    cookies: list[str]
    location: str = ""

    def json(self) -> object:
        try:
            parsed: object = json.loads(self.body.decode("utf-8")) if self.body else None
        except ValueError as err:
            raise ProbeError(f"HTTP {self.status} was not JSON: {self.text()[:300]}") from err
        return parsed

    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


def multipart(field: str, filename: str, ctype: str, data: bytes | Path) -> tuple[bytes, str]:
    boundary = "probe" + secrets.token_hex(12)
    head = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; '
        f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'
    )
    out = io.BytesIO()
    out.write(head.encode())
    out.write(data.read_bytes() if isinstance(data, Path) else data)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def check(reply: Reply, what: str, expect: tuple[int, ...] = (200, 201)) -> None:
    if reply.status not in expect:
        raise ProbeError(f"{what}: HTTP {reply.status} {reply.text()[:600]}")


def ok(reply: Reply, what: str, expect: tuple[int, ...] = (200, 201)) -> object:
    check(reply, what, expect)
    return reply.json()


class Ghost:
    """A running Ghost, reached on a published loopback port."""

    def __init__(self, name: str, site: str, port: int) -> None:
        self.name = name
        self.site = site
        self.port = port
        self.cookie = ""
        self.owner_email = f"owner-{secrets.token_hex(3)}@example.test"
        self.owner_password = secrets.token_hex(24)

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        timeout: float = 120,
    ) -> Reply:
        headers = {"Origin": self.site}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if content_type:
            headers["Content-Type"] = content_type
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            cookies = [v for k, v in resp.getheaders() if k.lower() == "set-cookie"]
            return Reply(resp.status, data, cookies, resp.getheader("location") or "")
        finally:
            conn.close()

    def api(self, method: str, endpoint: str, payload: object = None) -> Reply:
        body = None if payload is None else json.dumps(payload).encode()
        ctype = "application/json" if body is not None else None
        return self.request(method, f"/ghost/api/admin/{endpoint}", body=body, content_type=ctype)

    def upload(self, endpoint: str, filename: str, ctype: str, data: bytes) -> Reply:
        body, header = multipart("file", filename, ctype, data)
        return self.request("POST", f"/ghost/api/admin/{endpoint}", body=body, content_type=header)

    def wait_ready(self) -> None:
        deadline = time.monotonic() + BOOT_DEADLINE_S
        last = "no answer"
        while time.monotonic() < deadline:
            try:
                reply = self.request("GET", "/ghost/api/admin/site/", timeout=5)
                if reply.status == 200:
                    return
                last = f"HTTP {reply.status}"
            except OSError as err:
                last = str(err)
            time.sleep(1.5)
        raise ProbeError(f"{self.name} did not boot ({last}):\n{self.logs()[-3000:]}")

    def logs(self) -> str:
        return docker_quiet("logs", self.name)

    def setup_owner(self, blog_title: str) -> None:
        person = {
            "name": "Owner",
            "email": self.owner_email,
            "password": self.owner_password,
            "blogTitle": blog_title,
        }
        check(self.api("POST", "authentication/setup/", {"setup": [person]}), "owner setup", (201,))
        login = self.api(
            "POST", "session/", {"username": self.owner_email, "password": self.owner_password}
        )
        check(login, "login", (201,))
        self.cookie = "; ".join(c.split(";")[0] for c in login.cookies)

    def jobs_done(self) -> int:
        logs = self.logs()
        return max(
            logs.count("site-content-import completed in"),
            logs.count("site-content-import failed after"),
        )

    def job_failed(self) -> bool:
        """Ghost logs a swallowed import failure as an error and still ends the job as completed."""
        return "site-content-import error" in self.logs()

    def wait_jobs(self, count: int, deadline_s: float = JOB_DEADLINE_S) -> None:
        deadline = time.monotonic() + deadline_s
        while time.monotonic() < deadline:
            if self.jobs_done() >= count:
                return
            time.sleep(1.0)
        raise ProbeError(
            f"import job {count} did not finish in {self.name}:\n{self.logs()[-3000:]}"
        )

    def import_zip(self, zip_path: Path) -> Reply:
        """Upload the zip as the admin client does, streamed so a large one is not held."""
        boundary = "probe" + secrets.token_hex(12)
        head = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="importfile"; '
            f'filename="probe.zip"\r\nContent-Type: application/zip\r\n\r\n'
        ).encode()
        tail = f"\r\n--{boundary}--\r\n".encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=900)
        try:
            conn.putrequest("POST", "/ghost/api/admin/db/")
            conn.putheader("Origin", self.site)
            conn.putheader("Cookie", self.cookie)
            conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            conn.putheader("Content-Length", str(len(head) + zip_path.stat().st_size + len(tail)))
            conn.endheaders()
            conn.send(head)
            with zip_path.open("rb") as handle:
                while chunk := handle.read(4 * 1024 * 1024):
                    conn.send(chunk)
            conn.send(tail)
            resp = conn.getresponse()
            return Reply(resp.status, resp.read(), [], resp.getheader("location") or "")
        finally:
            conn.close()

    def export(self) -> Json:
        return as_obj(ok(self.api("GET", "db/"), "export"))

    def version(self) -> str:
        code = "require('/var/lib/ghost/current/package.json').version"
        return docker("exec", self.name, "node", "-p", code).strip()


# ------------------------------------------------------------------ containers


class Double:
    """The recording S3 double, a container from the Ghost image running the shared script."""

    def __init__(self, res: Resources, image: str) -> None:
        self.name = f"import-probe-double-{res.run_id}"
        self.port = start_container(
            res,
            self.name,
            image,
            {"DOUBLE_BUCKET": BUCKET},
            container_port=9090,
            entrypoint="node",
            command=["/double.cjs"],
            mounts=[f"{DOUBLE_SCRIPT}:/double.cjs:ro"],
        )
        self.endpoint = f"http://{self.name}:9090"
        deadline = time.monotonic() + 40
        while True:
            try:
                self.requests()
                return
            except (OSError, ValueError):
                if time.monotonic() > deadline:
                    raise ProbeError("the recording double did not answer") from None
                time.sleep(0.5)

    def requests(self) -> list[Json]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", "/__control/requests")
            parsed: object = json.loads(conn.getresponse().read())
            return [as_obj(r) for r in as_list(parsed)]
        finally:
            conn.close()

    def put_keys(self) -> set[str]:
        """Keys written so far, without the bucket."""
        found: set[str] = set()
        for req in self.requests():
            if req["shape"] in ("PutObject", "CreateMultipartUpload"):
                found.add(as_str(req["path"]).split("/", 2)[2])
        return found


def decorator_env(
    feature: str, wraps: str, refuse: Json | None = None, double: Double | None = None
) -> dict[str, str]:
    base = f"storage__{feature}"
    env = {
        f"{base}__adapter": "ScanningStorageAdapter",
        f"{base}__verdictSource": "in-process-fake",
        f"{base}__wraps": wraps,
        f"{base}__quarantinePath": "/var/lib/ghost/content/quarantine",
    }
    if refuse is not None and feature == "images":
        env[f"{base}__refuse"] = json.dumps(refuse)
    if double is not None:
        wrapped = f"{base}__wrappedConfig"
        env |= {
            f"{wrapped}__bucket": BUCKET,
            f"{wrapped}__staticFileURLPrefix": f"content/{feature}",
            f"{wrapped}__cdnUrl": MEDIA_ADDRESS,
            f"{wrapped}__tenantPrefix": TENANT_PREFIX,
            f"{wrapped}__endpoint": double.endpoint,
            f"{wrapped}__region": "us-east-1",
            f"{wrapped}__forcePathStyle": "true",
            f"{wrapped}__accessKeyId": "probe",
            f"{wrapped}__secretAccessKey": "probe",
            f"{wrapped}__multipartUploadThresholdBytes": str(5 * 1024 * 1024),
            f"{wrapped}__multipartChunkSizeBytes": str(5 * 1024 * 1024),
        }
    return env


def start_ghost(
    res: Resources, image: str, label: str, site: str, storage: dict[str, str]
) -> Ghost:
    name = f"import-probe-{label}-{res.run_id}"
    env = {
        "url": site,
        "database__client": "sqlite3",
        "database__connection__filename": "/var/lib/ghost/content/data/ghost.db",
        "privacy__useUpdateCheck": "false",
        "mail__transport": "stub",
        "imageOptimization__resize": "false",
        "storage__media__tier": "professional",
        "BRANCHLEFT_ALLOW_LOCAL_STORAGE": "true",
        **storage,
    }
    host = site.split("//", 1)[1].split(":", 1)[0]
    port = start_container(
        res, name, image, env, container_port=2368, add_hosts=[f"{host}:127.0.0.1"]
    )
    ghost = Ghost(name, site, port)
    ghost.wait_ready()
    return ghost


# ------------------------------------------------------------------ the demo


def upload_url(reply: Reply, what: str, key: str) -> str:
    return as_str(dig(ok(reply, what), key, 0, "url"))


def build_demo(ghost: Ghost) -> None:
    images: dict[str, str] = {}
    for index, stem in enumerate(IMAGE_STEMS):
        reply = ghost.upload(
            "images/upload/", f"probe-{stem}.png", "image/png", tiny_png(index + 1)
        )
        images[stem] = upload_url(reply, f"upload {stem}", "images")
    clip = ghost.upload("media/upload/", "probe-clip.mp4", "video/mp4", mp4_bytes())
    video = upload_url(clip, "upload media", "media")
    report = ghost.upload("files/upload/", "probe-report.pdf", "application/pdf", pdf_bytes())
    pdf = upload_url(report, "upload file", "files")

    me = as_obj(dig(ok(ghost.api("GET", "users/me/"), "me"), "users", 0))
    ok(
        ghost.api(
            "PUT",
            f"users/{me['id']}/",
            {
                "users": [
                    {
                        "id": me["id"],
                        "profile_image": images["author-profile"],
                        "cover_image": images["author-cover"],
                    }
                ]
            },
        ),
        "author images",
    )
    tag = {
        "name": "Probe tag",
        "feature_image": images["tag-feature"],
        "og_image": images["tag-og"],
        "twitter_image": images["tag-twitter"],
    }
    tag_id = dig(ok(ghost.api("POST", "tags/", {"tags": [tag]}), "tag"), "tags", 0, "id")
    settings = [
        ("title", "Demo Site Title"),
        ("description", "Demo description"),
        ("navigation", json.dumps([{"label": "About", "url": f"{DEMO_SITE}{PAGE_PATH}"}])),
        ("codeinjection_head", "<!-- demo head -->"),
        ("codeinjection_foot", "<!-- demo foot -->"),
        ("accent_color", "#123456"),
        ("locale", "fr"),
        ("timezone", "Asia/Tokyo"),
        ("meta_title", "Demo meta title"),
        ("og_title", "Demo og title"),
        ("logo", images["site-logo"]),
        ("icon", images["site-icon"]),
        ("cover_image", images["site-cover"]),
        ("og_image", images["site-og"]),
        ("twitter_image", images["site-twitter"]),
    ]
    ok(
        ghost.api("PUT", "settings/", {"settings": [{"key": k, "value": v} for k, v in settings]}),
        "settings",
    )
    newsletters = as_list(dig(ok(ghost.api("GET", "newsletters/"), "newsletters"), "newsletters"))
    if newsletters:
        nid = as_obj(newsletters[0])["id"]
        header = {"id": nid, "header_image": images["newsletter-header"]}
        ok(ghost.api("PUT", f"newsletters/{nid}/", {"newsletters": [header]}), "newsletter header")
    themes = [as_obj(t) for t in as_list(dig(ok(ghost.api("GET", "themes/"), "themes"), "themes"))]
    other = [t["name"] for t in themes if not t.get("active") and t["name"] != "casper"]
    if other:
        ok(ghost.api("PUT", f"themes/{other[0]}/activate/"), "activate a second theme")

    gallery = [
        {"row": 0, "fileName": "a.png", "src": images["lex-gallery-a"], "width": 2, "height": 2},
        {"row": 0, "fileName": "b.png", "src": images["lex-gallery-b"], "width": 2, "height": 2},
    ]
    html_card = (
        f'<img src="{images["lex-html-card"]}" alt="">'
        f'<a href="https://{DEMO_HOST}{PAGE_PATH}">another spelling</a>'
    )
    cards: list[object] = [
        image_card(images["lex-image"]),
        {"type": "gallery", "version": 1, "caption": "", "images": gallery},
        {
            "type": "file",
            "version": 1,
            "src": pdf,
            "fileTitle": "Report",
            "fileCaption": "",
            "fileName": "probe-report.pdf",
            "fileSize": len(pdf_bytes()),
        },
        {
            "type": "video",
            "version": 1,
            "src": video,
            "fileName": "probe-clip.mp4",
            "mimeType": "video/mp4",
            "width": 2,
            "height": 2,
            "duration": 1,
            "thumbnailSrc": images["lex-video-thumb"],
            "customThumbnailSrc": "",
            "thumbnailWidth": 2,
            "thumbnailHeight": 2,
            "cardWidth": "regular",
            "loop": False,
            "caption": "",
        },
        {
            "type": "bookmark",
            "version": 1,
            "url": "https://example.test/article",
            "caption": "",
            "metadata": {
                "icon": images["lex-bookmark-icon"],
                "title": "Bookmark",
                "description": "",
                "author": "",
                "publisher": "",
                "thumbnail": images["lex-bookmark-thumb"],
            },
        },
        {"type": "html", "version": 1, "html": html_card},
        paragraph_link(images["lex-link"], "a link to an uploaded image"),
        paragraph_link(f"{DEMO_SITE}{PAGE_PATH}", "a link to the demo's own page"),
        paragraph_link(pdf, "a link to an uploaded file"),
    ]
    post = {
        "title": MAIN_TITLE,
        "status": "published",
        "lexical": lexical_root(cards),
        "feature_image": images["post-feature"],
        "og_image": images["post-og"],
        "twitter_image": images["post-twitter"],
        "tags": [{"id": tag_id}],
        "authors": [{"id": me["id"]}],
    }
    ok(ghost.api("POST", "posts/?formats=lexical,html", {"posts": [post]}), "main post")
    plain = {
        "title": REGEX_TITLE,
        "status": "published",
        "lexical": lexical_root([paragraph_link("https://example.test/", "x")]),
    }
    ok(ghost.api("POST", "posts/?formats=lexical,html", {"posts": [plain]}), "regex-name post")


def served_files(content_dir: Path) -> list[Path]:
    """The originals in a copied media tree, without Ghost's resized variants."""
    found: list[Path] = []
    for sub in ("images", "media", "files"):
        root = content_dir / sub
        if root.is_dir():
            found += [
                p
                for p in sorted(root.rglob("*"))
                if p.is_file() and p.relative_to(root).parts[0] != "size"
            ]
    return found


def write_zip(target: Path, export: Json, media_dir: Path | None, padding_bytes: int = 0) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("ghost-export.json", json.dumps(export))
        if media_dir is not None:
            for path in served_files(media_dir):
                archive.write(path, f"content/{path.relative_to(media_dir).as_posix()}")
            archive.writestr(f"content/images/2026/11/{REGEX_NAME}", tiny_png(200))
        if padding_bytes:
            with archive.open("padding.bin", "w", force_zip64=True) as out:
                remaining = padding_bytes
                while remaining:
                    piece = min(remaining, 4 * 1024 * 1024)
                    out.write(os.urandom(piece))
                    remaining -= piece


def minimal_export(version: str) -> Json:
    now = "2026-11-19T00:00:00.000Z"
    post: Json = {
        "id": object_id(),
        "title": "size probe",
        "slug": f"size-probe-{secrets.token_hex(3)}",
        "status": "draft",
        "type": "post",
        "visibility": "public",
        "created_at": now,
        "updated_at": now,
    }
    meta: Json = {"exported_on": 1790000000000, "version": version}
    return {"db": [{"meta": meta, "data": {"posts": [post]}}]}


# ------------------------------------------------------------------ the tenant


def tenant_storage(double: Double, refuse: Json | None) -> dict[str, str]:
    storage: dict[str, str] = {}
    for feature in ("images", "media", "files"):
        storage |= decorator_env(feature, "S3Storage", refuse, double)
    # Ghost's zip import also hands a media file to the files store, whose
    # extension list holds .mp4, so that store must take video as well.
    storage["storage__files__tier"] = "professional"
    return storage


def demo_storage() -> dict[str, str]:
    storage: dict[str, str] = {}
    for feature, wraps in (
        ("images", "LocalImagesStorage"),
        ("media", "LocalMediaStorage"),
        ("files", "LocalFilesStorage"),
    ):
        storage |= decorator_env(feature, wraps)
    return storage


@dataclasses.dataclass
class Demo:
    export: Json
    content: Path
    version: str


def run_demo(res: Resources, image: str, work: Path) -> Demo:
    ghost = start_ghost(res, image, "demo", DEMO_SITE, demo_storage())
    try:
        ghost.setup_owner("Demo Site")
        build_demo(ghost)
        content = work / "demo-content"
        content.mkdir()
        docker("cp", f"{ghost.name}:/var/lib/ghost/content/.", str(content), timeout=300)
        return Demo(ghost.export(), content, ghost.version())
    finally:
        res.remove(ghost.name)


@dataclasses.dataclass
class Imported:
    double: Double
    tenant: Ghost
    before: Json
    reply: Reply
    outcome: str


def run_import(res: Resources, image: str, zip_path: Path, refuse: Json, label: str) -> Imported:
    double = Double(res, image)
    tenant = start_ghost(res, image, label, TENANT_SITE, tenant_storage(double, refuse))
    tenant.setup_owner("Tenant Site")
    before = tenant.export()
    reply = tenant.import_zip(zip_path)
    if reply.status >= 300:
        outcome = f"refused at upload (HTTP {reply.status})"
    else:
        tenant.wait_jobs(1)
        outcome = "failed" if tenant.job_failed() else "completed"
    return Imported(double, tenant, before, reply, outcome)


def drop(res: Resources, run: Imported) -> None:
    res.remove(run.tenant.name)
    res.remove(run.double.name)


def measure_staff(tenant: Ghost) -> list[Row]:
    users = [
        as_obj(u)
        for u in as_list(
            dig(ok(tenant.api("GET", "users/?include=roles&limit=all"), "users"), "users")
        )
    ]
    posts = as_list(
        dig(
            ok(tenant.api("GET", "posts/?include=authors&limit=all&fields=title"), "posts"), "posts"
        )
    )

    def roles(user: Json) -> str:
        return ", ".join(as_str(as_obj(r)["name"]) for r in as_list(user["roles"]))

    rows: list[Row] = []
    for slug, role in STAFF:
        found = [u for u in users if as_str(u["slug"]).startswith(slug)]
        if found:
            rows.append(
                Row(
                    f"staff user {slug} (was {role})",
                    f"created as {roles(found[0])}",
                    f"status {found[0]['status']}",
                )
            )
        else:
            rows.append(Row(f"staff user {slug} (was {role})", "not created"))
    staff_slugs = tuple(slug for slug, _ in STAFF)
    for user in users:
        if user["email"] == tenant.owner_email:
            rows.append(Row("the tenant's own owner", roles(user), f"status {user['status']}"))
        elif not as_str(user["slug"]).startswith(staff_slugs):
            rows.append(
                Row(
                    f"the demo's owner (imported as {user['slug']})",
                    roles(user),
                    f"status {user['status']}",
                )
            )
    for item in posts:
        post = as_obj(item)
        names = ", ".join(as_str(as_obj(a)["slug"]) for a in as_list(post["authors"]))
        rows.append(Row(f"authors of post '{post['title']}'", names or "none"))
    return rows


# ------------------------------------------------------------------ size ladder


@dataclasses.dataclass
class SizeStep:
    mib: int
    status: int
    reply: str


def size_ladder(tenant: Ghost, version: str, cap_mib: int, work: Path) -> list[SizeStep]:
    steps: list[SizeStep] = []
    mib = 1
    jobs = tenant.jobs_done()
    while mib <= cap_mib:
        target = work / f"size-{mib}.zip"
        write_zip(target, minimal_export(version), None, mib * 1024 * 1024)
        try:
            reply = tenant.import_zip(target)
        except OSError as err:
            reply = Reply(0, f"no answer: {err}".encode(), [])
        target.unlink()
        steps.append(SizeStep(mib, reply.status, reply.text()[:160].replace("\n", " ")))
        if reply.status >= 400 or reply.status == 0:
            break
        jobs += 1
        tenant.wait_jobs(jobs)
        mib *= 4
    return steps


def render(
    version: str,
    refs: list[Row],
    settings: list[Row],
    staff: list[Row],
    control: dict[str, str],
    ladder: list[SizeStep],
    cap_mib: int,
    extra: dict[str, str],
) -> str:
    refused = [s for s in ladder if s.status >= 400 or s.status == 0]
    verdict = (
        f"The import was refused at {refused[0].mib} MiB of padding."
        if refused
        else f"The import was not refused at any size up to {cap_mib} MiB of padding."
    )
    return "\n".join(
        [
            f"Ghost {version}: scanning decorator over S3, a tenant prefix, a media cdnUrl",
            "",
            "References after Ghost's zip import",
            table(
                ["Field class", "Result", "Reference as stored", "Object"],
                [(r.item, r.result, r.detail, r.extra) for r in refs],
            ),
            "",
            "Settings",
            table(["Key", "Result", "Values"], [(r.item, r.result, r.detail) for r in settings]),
            "",
            "Staff users and authors",
            table(
                ["Item", "Result", "Detail", ""],
                [(r.item, r.result, r.detail, r.extra) for r in staff],
            ),
            "",
            "Control: one image of the zip is on the hash list",
            table(["Measure", "Value"], list(control.items())),
            "",
            "Zip size: a padded zip is uploaded at each size, raised fourfold until one is refused",
            table(
                ["Padding MiB", "HTTP status", "Reply"],
                [(str(s.mib), str(s.status), s.reply) for s in ladder],
            ),
            verdict,
            "",
            "Storage",
            table(["Measure", "Value"], list(extra.items())),
        ]
    )


def probe(args: argparse.Namespace, res: Resources, work: Path, failures: list[str]) -> None:
    res.create_network()
    demo = run_demo(res, args.image, work)
    zipped = json.loads(json.dumps(demo.export))
    add_staff_and_regex_name(zipped)
    zip_path = work / "demo.zip"
    write_zip(zip_path, as_obj(zipped), demo.content)

    victim = next(p for p in served_files(demo.content) if "post-feature" in p.name)
    digest = hashlib.sha256(victim.read_bytes()).hexdigest()
    listed: Json = {digest: {"classification": "harmful-abusive-material", "matchType": "exact"}}
    refuse = {} if args.sabotage == "empty-control-list" else listed
    run = run_import(res, args.image, zip_path, refuse, "control")
    try:
        left = len(
            as_list(dig(ok(run.tenant.api("GET", "posts/?limit=all&fields=id"), "posts"), "posts"))
        )
        written = len(run.double.put_keys())
        shapes = ", ".join(sorted({as_str(r["shape"]) for r in run.double.requests()}))
    finally:
        drop(res, run)
    control = {
        "image on the list": victim.name,
        "import outcome": run.outcome,
        "posts the refused import left in the tenant": str(left),
        "objects the refused import wrote to storage": str(written),
        "request shapes during the refused import": shapes,
    }
    if run.outcome == "completed":
        failures.append("CONTROL: the import completed with an image on the hash list")

    run = run_import(res, args.image, zip_path, {}, "tenant")
    try:
        if run.outcome != "completed":
            raise ProbeError(
                f"the clean import did not complete ({run.outcome})\n{run.tenant.logs()[-4000:]}"
            )
        after = run.tenant.export()
        stored = run.double.put_keys()
        refs = measure_references(as_obj(zipped), after, stored)
        settings = measure_settings(demo.export, run.before, after)
        staff = measure_staff(run.tenant)
        outside = [k for k in stored if not k.startswith(f"{TENANT_PREFIX}/")]
        extra = {
            "import reply": f"HTTP {run.reply.status} {run.reply.text()[:100]}",
            "objects written": str(len(stored)),
            "objects outside the tenant prefix": str(len(outside)),
            "objects by folder": ", ".join(
                f"{kind}={sum(1 for k in stored if f'/content/{kind}/' in k)}"
                for kind in ("images", "media", "files")
            ),
            "request shapes": ", ".join(
                sorted({as_str(r["shape"]) for r in run.double.requests()})
            ),
            "posts in the zip / in the tenant": (
                f"{len(rows_of(demo.export, 'posts'))} / {len(rows_of(after, 'posts'))}"
            ),
        }
        sample = next((k for k in sorted(stored) if "/content/images/" in k), None)
        if sample is not None:
            path = "/" + sample.split("/", 1)[1]
            got = run.tenant.request("GET", path)
            extra["GET of a stored image's site-relative path on the tenant"] = (
                f"HTTP {got.status} -> {got.location}"
            )
        ladder = size_ladder(run.tenant, demo.version, args.max_zip_mib, work)
    finally:
        drop(res, run)
    report = render(demo.version, refs, settings, staff, control, ladder, args.max_zip_mib, extra)
    print(report)
    if args.report:
        args.report.write_text(report + "\n", encoding="utf-8")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"### Ghost zip import probe\n\n```\n{report}\n```\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Probe Ghost's own zip import against the built image."
    )
    parser.add_argument(
        "--image", required=True, help="the built Ghost image, e.g. ghost-platform:ci"
    )
    parser.add_argument(
        "--max-zip-mib", type=int, default=256, help="largest padding the size ladder uploads"
    )
    parser.add_argument("--report", type=Path, help="also write the report to this file")
    parser.add_argument(
        "--sabotage",
        choices=["empty-control-list"],
        help="run the control with nothing listed, which must fail",
    )
    args = parser.parse_args(argv)

    res = Resources()
    work = Path(tempfile.mkdtemp(prefix="ghost-import-probe-"))
    failures: list[str] = []
    try:
        probe(args, res, work, failures)
    except (ProbeError, OSError, subprocess.SubprocessError) as err:
        failures.append(f"PROBE: {err}")
    finally:
        left = res.cleanup()
        shutil.rmtree(work, ignore_errors=True)
        if left:
            failures.append(f"LEFTOVER: {left}")
    for failure in failures:
        sys.stderr.write(f"FAIL {failure}\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
