"""The lab topology: one database, the upstream service, one platform Ghost and a TLS edge.

The edge stands in for the tenants edge: it terminates TLS for the site name,
routes the federation paths to the service and everything else to Ghost. Both
Ghost and the service reach the site by its public name through the edge, as
they do in production. Layout and reasoning: CONTRACT.md.
"""

from __future__ import annotations

import secrets
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from database import Database
from dockerx import Lab, host_port, http_request, logs, wait_until

SITE_NAME = "ghost.test"
OWNER_EMAIL = "owner@ghost.test"
# Made fresh for every run, and long enough for Ghost's own password rules.
OWNER_PASSWORD = f"Ap-{secrets.token_hex(16)}"
SERVICE_PORT = 8080
GHOST_PORT = 2368
EDGE_IMAGE = "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de"
STORAGE_URL = f"https://{SITE_NAME}/.ghost/activitypub/local-storage"

# The paths the edge sends to the service. A path missing here is a path the
# contract says the edge must carry; the proof of each is in the observations.
EDGE_FEDERATION_PATTERN = r"^/(\.ghost/activitypub/|\.well-known/(webfinger|nodeinfo)$)"

NGINX_CONF = """\
log_format apc '$request_method $uri $status $host scheme=$scheme to=$upstream_addr';
access_log /dev/stdout apc;
server {
    listen 443 ssl;
    listen 80;
    server_name @SITE@;
    ssl_certificate /etc/nginx/apc-tls/site.pem;
    ssl_certificate_key /etc/nginx/apc-tls/site.key;
    client_max_body_size 10m;
    location ~ @PATTERN@ {
        proxy_pass http://@SERVICE_HOST@:@SERVICE_PORT@;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
    location / {
        proxy_pass http://@GHOST_HOST@:@GHOST_PORT@;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
"""


def make_certificate(directory: Path) -> Path:
    """A self-signed certificate for SITE_NAME; the certificate is its own CA file."""
    key = directory / "site.key"
    cert = directory / "site.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-subj",
            f"/CN={SITE_NAME}",
            "-addext",
            f"subjectAltName=DNS:{SITE_NAME}",
        ],
        check=True,
        capture_output=True,
    )
    key.chmod(0o644)
    return cert


@dataclass
class Topology:
    lab: Lab
    database: Database
    certs: Path
    service_env: dict[str, str]
    service_image: str
    ghost_image: str
    service_name: str = ""
    ghost_name: str = ""
    edge_name: str = ""
    workdir: tempfile.TemporaryDirectory[str] = field(default_factory=tempfile.TemporaryDirectory)

    @property
    def ca(self) -> str:
        return str(self.certs / "site.pem")

    @property
    def ca_dir(self) -> Path:
        """A directory holding only the public certificate, for containers that must trust it."""
        target = Path(self.workdir.name) / "ca"
        if not target.exists():
            target.mkdir()
            (target / "site.pem").write_text((self.certs / "site.pem").read_text())
        return target

    def start_service(
        self, env: dict[str, str], role: str = "service", publish: bool = True
    ) -> str:
        name = self.lab.start(
            role,
            self.service_image,
            env=env,
            publish=[SERVICE_PORT] if publish else [],
            copies=[(str(self.ca_dir), "/apc-ca")],
            extra=["-e", "NODE_EXTRA_CA_CERTS=/apc-ca/site.pem"],
        )
        return name

    def service_port(self, name: str | None = None) -> int:
        return host_port(name or self.service_name, SERVICE_PORT)

    def start_ghost(self, extra_env: dict[str, str] | None = None) -> str:
        env = {
            "url": f"https://{SITE_NAME}",
            "database__client": "sqlite3",
            "database__connection__filename": "/var/lib/ghost/content/data/ghost.db",
            "privacy__useUpdateCheck": "false",
            "mail__transport": "Direct",
            "BRANCHLEFT_ALLOW_LOCAL_STORAGE": "true",
            "storage__images__adapter": "ScanningStorageAdapter",
            "storage__images__wraps": "LocalImagesStorage",
            "storage__images__quarantinePath": "/var/lib/ghost/content/quarantine",
            "storage__media__adapter": "ScanningStorageAdapter",
            "storage__media__wraps": "LocalMediaStorage",
            "storage__media__quarantinePath": "/var/lib/ghost/content/quarantine",
            "storage__files__adapter": "ScanningStorageAdapter",
            "storage__files__wraps": "LocalFilesStorage",
            "storage__files__quarantinePath": "/var/lib/ghost/content/quarantine",
            "NODE_EXTRA_CA_CERTS": "/apc-ca/site.pem",
            **(extra_env or {}),
        }
        self.ghost_name = self.lab.start(
            "ghost", self.ghost_image, env=env, copies=[(str(self.ca_dir), "/apc-ca")]
        )
        return self.ghost_name

    def start_edge(self) -> str:
        conf = (
            NGINX_CONF.replace("@SITE@", SITE_NAME)
            .replace("@PATTERN@", EDGE_FEDERATION_PATTERN)
            .replace("@SERVICE_HOST@", "service")
            .replace("@SERVICE_PORT@", str(SERVICE_PORT))
            .replace("@GHOST_HOST@", "ghost")
            .replace("@GHOST_PORT@", str(GHOST_PORT))
        )
        conf_path = self.ca_dir.parent / "default.conf"
        conf_path.write_text(conf)
        self.edge_name = self.lab.start(
            "edge",
            EDGE_IMAGE,
            aliases=[SITE_NAME],
            publish=[443],
            copies=[
                (str(self.certs), "/etc/nginx/apc-tls"),
                (str(conf_path), "/etc/nginx/conf.d/default.conf"),
            ],
        )
        return self.edge_name

    def edge_port(self) -> int:
        return host_port(self.edge_name, 443)

    def edge_request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes = b"",
    ) -> tuple[int, bytes, dict[str, str]]:
        answer = http_request(
            self.edge_port(),
            method,
            path,
            host=SITE_NAME,
            headers=headers,
            body=body,
            tls_ca=self.ca,
            sni=SITE_NAME,
        )
        return answer.status, answer.body, dict(answer.headers)

    def wait_for_ghost(self) -> None:
        wait_until(
            lambda: self.edge_request("GET", "/")[0] == 200,
            seconds=240,
            what="Ghost home page through the edge",
            every=2.0,
        )

    def edge_log(self) -> str:
        return logs(self.edge_name)
