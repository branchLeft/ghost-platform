"""The contract: what the platform may rely on from the upstream ActivityPub service.

Each `Fact` is one claim with the value the harness must observe. The harness
(`harness.py`) starts the pinned upstream image and records an observation per
key; `problems()` lists every fact that was not observed or observed
differently. Reading order and the commands are in CONTRACT.md.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

type Json = str | int | float | bool | list[Json] | dict[str, Json] | None

UPSTREAM_REPOSITORY = "https://github.com/TryGhost/ActivityPub.git"
UPSTREAM_COMMIT = "c0124ca6c8a7796f65a2cae5783a79058c7a5a61"

# Every variable the platform must set on the service for it to work in
# production with a local file store and no queue. The harness starts the
# baseline service with exactly these and nothing else.
REQUIRED_ENV: tuple[str, ...] = (
    "NODE_ENV",
    "MYSQL_HOST",
    "MYSQL_PORT",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
    "MYSQL_DATABASE",
    "LOCAL_STORAGE_PATH",
    "LOCAL_STORAGE_HOSTING_URL",
)

# What the service does when one required variable is left out.
DB_UNREACHABLE = "serves /ping, database route answers 500"
ENV_WHEN_MISSING: Mapping[str, str] = {
    "NODE_ENV": "works",
    "MYSQL_HOST": DB_UNREACHABLE,
    "MYSQL_PORT": "works",
    "MYSQL_USER": DB_UNREACHABLE,
    "MYSQL_PASSWORD": DB_UNREACHABLE,
    "MYSQL_DATABASE": DB_UNREACHABLE,
    "LOCAL_STORAGE_PATH": "exits",
    "LOCAL_STORAGE_HOSTING_URL": "exits",
}

MIGRATE_PRIVILEGES: tuple[str, ...] = (
    "ALTER",
    "CREATE",
    "CREATE TEMPORARY TABLES",
    "DELETE",
    "DROP",
    "INDEX",
    "INSERT",
    "REFERENCES",
    "SELECT",
    "UPDATE",
)
SERVICE_PRIVILEGES: tuple[str, ...] = ("DELETE", "INSERT", "SELECT", "UPDATE")


@dataclass(frozen=True)
class Route:
    """One request the harness sends to the service, with the Host header of a site."""

    method: str
    path: str
    note: str

    @property
    def key(self) -> str:
        return f"route {self.method} {self.path}"


# The anonymous request table. `unregistered` is the answer for a Host the
# service has never seen; `registered` for the registered site.
ROUTES: tuple[Route, ...] = (
    Route("GET", "/ping", "health"),
    Route("GET", "/", "root"),
    Route("GET", "/.ghost/activitypub/v1/site", "registration and site data"),
    Route("DELETE", "/.ghost/activitypub/v1/site", "disable the site"),
    Route("GET", "/.well-known/webfinger?resource=acct:index@ghost.test", "webfinger"),
    Route("GET", "/.well-known/nodeinfo", "nodeinfo index"),
    Route("GET", "/.ghost/activitypub/nodeinfo/2.1", "nodeinfo"),
    Route("GET", "/.ghost/activitypub/users/index", "actor"),
    Route("GET", "/.ghost/activitypub/followers/index", "followers collection"),
    Route("GET", "/.ghost/activitypub/outbox/index", "outbox collection"),
    Route("POST", "/.ghost/activitypub/inbox/index", "personal inbox, unsigned"),
    Route("POST", "/.ghost/activitypub/inbox", "shared inbox, unsigned"),
    Route("GET", "/.ghost/activitypub/stable/client-config", "client config, no token"),
    Route("GET", "/.ghost/activitypub/v1/account/me", "own account, no token"),
    Route("POST", "/.ghost/activitypub/v1/webhooks/post/published", "Ghost webhook, unsigned"),
    Route("POST", "/.ghost/activitypub/v1/webhooks/post/unpublished", "Ghost webhook, unsigned"),
    Route("POST", "/.ghost/activitypub/v1/webhooks/post/updated", "Ghost webhook, unsigned"),
    Route("POST", "/.ghost/activitypub/v1/webhooks/post/deleted", "Ghost webhook, unsigned"),
    Route("POST", "/.ghost/activitypub/pubsub/ghost/push", "queue push endpoint"),
    Route("POST", "/.ghost/activitypub/pubsub/fedify/push", "queue push endpoint"),
    Route("GET", "/.ghost/activitypub/local-storage/images/none.png", "stored files"),
)

DATABASE_LABELS: tuple[str, ...] = ("percona-8.0.46", "mysql-8.4.13")


@dataclass(frozen=True)
class Fact:
    """`op` is `eq` (equal), `le` (observed is at most expected) or `ge`."""

    key: str
    claim: str
    expected: Json
    op: str = "eq"


def failing(facts: Sequence[Fact], observed: Mapping[str, Json]) -> list[tuple[str, str]]:
    """(key, reason) for each fact that was not observed, or observed differently."""
    found: list[tuple[str, str]] = []
    for fact in facts:
        if fact.key not in observed:
            found.append((fact.key, "not observed"))
            continue
        got = observed[fact.key]
        if fact.op == "eq":
            good = got == fact.expected
        elif isinstance(got, (int, float)) and isinstance(fact.expected, (int, float)):
            good = got <= fact.expected if fact.op == "le" else got >= fact.expected
        else:
            good = False
        if not good:
            found.append((fact.key, f"expected {fact.op} {fact.expected!r}, observed {got!r}"))
    return found


def problems(facts: Sequence[Fact], observed: Mapping[str, Json]) -> list[str]:
    """One line for each fact that was not observed, or observed differently."""
    return [f"{key}: {reason}" for key, reason in failing(facts, observed)]


# The answers to ROUTES, anonymous, as (Host not registered, Host registered).
ROUTE_ANSWERS: Mapping[str, tuple[int, int]] = {
    "route GET /ping": (200, 200),
    "route GET /": (302, 302),
    "route GET /.ghost/activitypub/v1/site": (403, 403),
    "route DELETE /.ghost/activitypub/v1/site": (403, 403),
    "route GET /.well-known/webfinger?resource=acct:index@ghost.test": (403, 200),
    "route GET /.well-known/nodeinfo": (403, 200),
    "route GET /.ghost/activitypub/nodeinfo/2.1": (403, 200),
    "route GET /.ghost/activitypub/users/index": (403, 200),
    "route GET /.ghost/activitypub/followers/index": (403, 200),
    "route GET /.ghost/activitypub/outbox/index": (403, 200),
    "route POST /.ghost/activitypub/inbox/index": (403, 400),
    "route POST /.ghost/activitypub/inbox": (403, 400),
    "route GET /.ghost/activitypub/stable/client-config": (403, 200),
    "route GET /.ghost/activitypub/v1/account/me": (403, 403),
    "route POST /.ghost/activitypub/v1/webhooks/post/published": (403, 401),
    "route POST /.ghost/activitypub/v1/webhooks/post/unpublished": (403, 401),
    "route POST /.ghost/activitypub/v1/webhooks/post/updated": (403, 401),
    "route POST /.ghost/activitypub/v1/webhooks/post/deleted": (403, 401),
    "route POST /.ghost/activitypub/pubsub/ghost/push": (400, 400),
    "route POST /.ghost/activitypub/pubsub/fedify/push": (429, 429),
    "route GET /.ghost/activitypub/local-storage/images/none.png": (403, 404),
}


def _facts() -> list[Fact]:
    always: list[Fact] = [
        Fact(
            "service.image.cmd",
            "the service image's command starts the bundle with node",
            ["node", "dist/app.js"],
        ),
        Fact(
            "service.image.entrypoint",
            "the entrypoint is the Node base image's",
            ["docker-entrypoint.sh"],
        ),
        Fact(
            "service.image.workdir",
            "the working directory of the service image",
            "/opt/activitypub",
        ),
        Fact("service.image.exposed_ports", "the only port the image declares", ["8080/tcp"]),
        Fact(
            "service.image.user",
            "the image sets no USER: the process is root unless the host sets one",
            "root",
        ),
        Fact(
            "service.image.baked_env",
            "the only variable the image sets itself (so a host that clears it gets a non-production service)",
            ["NODE_ENV"],
        ),
        Fact("service.image.node_version", "the Node runtime in the image", "v26.13.1"),
        Fact("service.image.has_healthcheck", "the image declares no HEALTHCHECK", False),
        Fact(
            "migrate.image.cmd",
            "the migrate image's command applies every pending migration",
            ["up"],
        ),
        Fact("migrate.image.entrypoint", "the migrate image has no entrypoint", None),
        Fact(
            "migrate.image.workdir",
            "the migrate image's working directory (migrations are at /migrations)",
            "/",
        ),
        Fact("migrate.image.tool_version", "the migration tool in the migrate image", "4.20.1"),
        Fact(
            "migrate.image.user",
            "the migrate image also runs as root unless the host sets a user",
            "root",
        ),
        Fact(
            "db.percona-8.0.46.version_prefix",
            "the platform's own MySQL server version runs the migrate image and the service",
            True,
        ),
        Fact(
            "db.mysql-8.4.13.version_prefix",
            "the upstream project's own MySQL version, the other end of the range",
            True,
        ),
        Fact(
            "db.server.character_set",
            "the server default character set of the platform's database image",
            "utf8mb4",
        ),
        Fact(
            "db.server.collation",
            "the server default collation of the platform's database image",
            "utf8mb4_0900_ai_ci",
        ),
        Fact(
            "db.server.max_connections",
            "the platform database image's connection cap, which the service's pool must stay under",
            151,
        ),
        Fact(
            "migrate.full_privileges.exit",
            "the migrate image succeeds with exactly the ten privileges in MIGRATE_PRIVILEGES",
            0,
        ),
        Fact(
            "migrate.dsn_form.exit",
            "the migrate image also succeeds when given one DSN in MYSQL_DB",
            0,
        ),
        Fact(
            "migrate.version", "the schema version after migrating and whether it is dirty", "84:0"
        ),
        Fact(
            "migrate.rerun.exit",
            "a second run of the migrate image against a migrated schema succeeds",
            0,
        ),
        Fact("migrate.rerun.says_no_change", "and says it changed nothing", True),
        Fact(
            "migrate.table_collations",
            "every table collation the migrations create",
            ["utf8mb4_0900_ai_ci"],
        ),
        Fact(
            "migrate.column_collations",
            "every column collation the migrations create",
            ["utf8mb4_0900_ai_ci"],
        ),
        Fact("migrate.tables", "the tables the migrations create", _TABLES),
        Fact(
            "migrate.privilege_necessity",
            "taking any one privilege away makes the migrate image fail",
            dict.fromkeys(MIGRATE_PRIVILEGES, "required"),
        ),
        Fact("db.mysql-8.4.13.migrate_exit", "the migrate image succeeds on MySQL 8.4", 0),
        Fact("db.mysql-8.4.13.migration_version", "to the same schema version", "84:0"),
        Fact("db.mysql-8.4.13.table_count", "with the same number of tables", 23),
        Fact("db.mysql-8.4.13.service_ping", "the service starts on it", True),
        Fact(
            "db.mysql-8.4.13.service_reaches_database",
            "and reaches its database (403 means the site lookup ran)",
            403,
        ),
        Fact(
            "db.service_dml_only.register_status",
            "a service account with SELECT, INSERT, UPDATE and DELETE only can register a site",
            200,
        ),
        Fact("db.service_dml_only.sites_rows", "and the row is there", 1),
        Fact(
            "db.service_select_only.register_status",
            "an account with SELECT only cannot (the service answers 500)",
            500,
        ),
        Fact("db.service_select_only.sites_rows", "and no row is written", 0),
        Fact(
            "db.idle_connections",
            "connections the service holds when idle (pool minimum 1)",
            2,
            "le",
        ),
        Fact(
            "db.pool_max_3.peak_connections",
            "MYSQL_CONN_POOL_MAX caps connections: with 3, 24 parallel workers never exceed 3",
            3,
            "le",
        ),
        Fact("db.pool_max_3.failures", "and no request fails for it", 0),
        Fact(
            "service.baseline.ping",
            "the service started with exactly REQUIRED_ENV answers /ping",
            True,
        ),
        Fact(
            "service.baseline.database_route",
            "and reaches its database (403 SITE_MISSING for an unknown Host)",
            403,
        ),
        Fact("service.baseline.ready_seconds", "seconds from start to /ping 200", 15, "le"),
        Fact("service.boot.queue_line", "the boot log says the message queue is disabled", True),
        Fact("service.boot.kv_store_line", "and that Fedify uses the MySQL key-value store", True),
        Fact(
            "service.boot.listen_line", "and that it listens on port 8080 on all interfaces", True
        ),
        Fact("service.boot.process_user", "the numeric user of the process", "0"),
        Fact(
            "health.ping_with_database_unreachable",
            "/ping still answers 200 when the database is unreachable",
            200,
        ),
        Fact(
            "health.database_route_with_database_unreachable",
            "while a route that needs the database answers 500",
            500,
        ),
        Fact(
            "route.no_host_header",
            "a request with no Host header is refused by the HTTP server before the app",
            400,
        ),
        Fact("route.ping_any_host", "/ping answers 200 for any Host", 200),
    ]
    for name in REQUIRED_ENV:
        always.append(
            Fact(f"env.missing.{name}", f"the service with {name} left out", ENV_WHEN_MISSING[name])
        )
    for route in ROUTES:
        unregistered, registered = ROUTE_ANSWERS[route.key]
        always.append(
            Fact(
                route.key,
                f"{route.note}: anonymous answer for an unregistered and for a registered Host",
                {"unregistered": unregistered, "registered": registered},
            )
        )
    always += [
        Fact(
            "registration.sites_row",
            "Ghost's own boot registers the site: one row, with a Ghost UUID and a webhook secret",
            [["ghost.test", "uuid", "secret"]],
        ),
        Fact(
            "registration.service_fetches_from_site",
            "what the service fetches from the site to register it",
            ["GET /ghost/.well-known/jwks.json", "GET /ghost/api/admin/site/"],
        ),
        Fact(
            "registration.ghost_requests_to_service",
            "what Ghost itself calls on the service, at its own public address",
            ["GET /.ghost/activitypub/v1/site", "GET /.ghost/activitypub/v1/site/"],
        ),
        Fact(
            "ghost.webhooks",
            "the four webhooks Ghost registers for itself",
            [
                "post.deleted -> /.ghost/activitypub/v1/webhooks/post/deleted",
                "post.published -> /.ghost/activitypub/v1/webhooks/post/published",
                "post.published.edited -> /.ghost/activitypub/v1/webhooks/post/updated",
                "post.unpublished -> /.ghost/activitypub/v1/webhooks/post/unpublished",
            ],
        ),
        Fact(
            "ghost.log.webhooks_in_correct_state",
            "Ghost logs that its webhooks are in the correct state",
            True,
        ),
        Fact(
            "ghost.serves_activitypub_paths_itself",
            "Ghost answers the federation paths itself (false: it answers 404, so nothing proxies them but the edge)",
            False,
        ),
        Fact(
            "auth.v1_site_anonymous",
            "registration with no credential is refused",
            '{"error":"Forbidden","code":"ROLE_MISSING"}',
        ),
        Fact(
            "auth.v1_site_owner_token",
            "registration with a Ghost owner identity token succeeds",
            200,
        ),
        Fact(
            "auth.v1_site_response_fields",
            "and returns the webhook secret, so it must never be routed to a browser",
            ["actorUrl", "domain", "ghost_uuid", "handle", "host", "id", "webhook_secret"],
        ),
        Fact(
            "auth.token_checked_against_host_jwks",
            "the token is checked against the key set of the Host in the request",
            '401 {"error":"Unauthorized","code":"JWKS_MISSING"}',
        ),
        Fact(
            "headers.actor_id",
            "the actor id the service generates for the site",
            "https://ghost.test/.ghost/activitypub/users/index",
        ),
        Fact(
            "headers.unknown_host_answer",
            "a Host the service has no site for",
            '{"error":"Forbidden","code":"SITE_MISSING"}',
        ),
        Fact(
            "headers.x_forwarded_host_changes_actor_id",
            "X-Forwarded-Host rewrites the ids in a response, so the edge must overwrite it",
            True,
        ),
        Fact(
            "headers.x_forwarded_proto_changes_actor_id",
            "X-Forwarded-Proto does not (production forces https)",
            False,
        ),
        Fact("headers.x_forwarded_for_changes_actor_id", "X-Forwarded-For does not", False),
        Fact(
            "headers.accept_header_forced",
            "the service answers every request as ActivityPub JSON whatever Accept says",
            "application/activity+json",
        ),
        Fact("storage.upload_status", "an authenticated image upload succeeds", 200),
        Fact(
            "storage.file_url_starts_with_hosting_url",
            "its file URL starts with LOCAL_STORAGE_HOSTING_URL",
            True,
        ),
        Fact(
            "storage.file_written_under_path",
            "and the file is under LOCAL_STORAGE_PATH at the same relative path",
            True,
        ),
        Fact(
            "storage.file_served_by_service_in_production",
            "the service does not serve the stored file in production (404): something else must serve the directory",
            404,
        ),
        Fact("storage.dir_owner", "the owner of the storage directory the service writes", "root"),
        Fact(
            "storage.hosting_url_is_global_not_per_host",
            "LOCAL_STORAGE_HOSTING_URL is one value for every site, not derived from the Host",
            True,
        ),
        Fact(
            "storage.upload_without.LOCAL_STORAGE_PATH", "with LOCAL_STORAGE_PATH left out", "exits"
        ),
        Fact(
            "storage.upload_without.LOCAL_STORAGE_HOSTING_URL",
            "with LOCAL_STORAGE_HOSTING_URL left out",
            "exits",
        ),
        Fact(
            "private_lookup.production.reached_the_site",
            "in production a lookup of an actor on a host that resolves to a private address is refused before any request is made",
            0,
        ),
        Fact(
            "private_lookup.allowed.reached_the_site",
            "control: the same lookup with NODE_ENV=testing and ALLOW_PRIVATE_ADDRESS=true does reach the site",
            1,
            "ge",
        ),
        Fact(
            "restart.stop_seconds",
            "seconds a stop takes: the service waits nine seconds on SIGTERM",
            9,
            "ge",
        ),
        Fact("restart.exit_code", "and exits 0 by itself", 0),
        Fact("restart.ready_again", "the same container answers /ping after a start", True),
        Fact(
            "restart.site_survives",
            "and its site is still served (the state is in the database)",
            200,
        ),
        Fact("resources.idle.memory_mib", "resident memory, idle, MiB", 250, "le"),
        Fact("resources.idle.cpu_percent", "CPU, idle, percent of one core", 5, "le"),
        Fact(
            "resources.loaded.memory_mib",
            "peak memory under 24 parallel workers for 1500 webfinger requests, MiB",
            400,
            "le",
        ),
    ]
    return always


_TABLES: list[Json] = [
    "account_aliases",
    "account_delivery_backoffs",
    "account_moves",
    "account_topics",
    "accounts",
    "blocks",
    "bluesky_integration_account_handles",
    "discovery_feeds",
    "domain_blocks",
    "feeds",
    "follows",
    "ghost_ap_post_mappings",
    "key_value",
    "likes",
    "mentions",
    "notifications",
    "outboxes",
    "posts",
    "reposts",
    "schema_migrations",
    "sites",
    "topics",
    "users",
]

FACTS: list[Fact] = _facts()


TABLE_BEGIN = "<!-- facts:begin -->"
TABLE_END = "<!-- facts:end -->"


def render_table(facts: Sequence[Fact]) -> str:
    """The Markdown table CONTRACT.md carries between its fact markers."""
    symbol = {"eq": "=", "le": "at most", "ge": "at least"}
    lines = ["| Key | What it says | Must be observed |", "| --- | --- | --- |"]
    for fact in facts:
        shown = json.dumps(fact.expected, sort_keys=True).replace("|", "\\|")
        prefix = "" if fact.op == "eq" else f"{symbol[fact.op]} "
        lines.append(f"| `{fact.key}` | {fact.claim} | {prefix}`{shown}` |")
    return "\n".join(lines)
