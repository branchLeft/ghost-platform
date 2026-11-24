# The ActivityPub service contract

What the platform may rely on from the upstream ActivityPub service, observed by running it
rather than read from its documents. The service is `TryGhost/ActivityPub` at the one pinned
commit in `contract.py` (`UPSTREAM_COMMIT`, MIT licence). Every row of the table at the end is
a fact the harness observed and a test can fail on; the prose below says what each answer means
for the parts that build on it.

## Rerun it

```bash
docker build --tag ghost-platform:ci .
python3 scripts/activitypub-contract/harness.py --ghost-image ghost-platform:ci
```

The harness fetches the pinned commit, builds the service (`production` target) and the migrate
image from it, and starts, on one throwaway Docker network:

- a database (the platform's Percona 8.0.46 by digest; MySQL 8.4.13, the upstream project's own
  version, for the other end of the range);
- the migrate image, then the service in `NODE_ENV=production` with a local file store and no queue;
- one platform Ghost image on SQLite, whose public name is `ghost.test`;
- a TLS edge that stands in for the tenants edge: it terminates TLS for that name, sends the
  federation paths to the service and the rest to Ghost.

It exits 0 only when every fact below was observed as stated. `--learn` prints the observations
and exits 0; `--observations FILE` saves them. The tests that need no Docker are
`python3 -m unittest discover -s scripts/activitypub-contract -p 'test_*.py'`, the types are
`python3 -m mypy scripts/activitypub-contract` (config beside the code, strict).

## The answers

### 1. Production, no queue, no key-value store beyond MySQL, local files

It starts and works. The boot log says `Message queue is disabled` and `Using MySQL KvStore for
Fedify`. Health is `GET /ping` on port 8080 (the `PORT` variable moves it), answered 200 for any
`Host`, and it is **not a readiness check**: it stays 200 when the database is unreachable
(`health.*`), and a database-touching route then answers 500. A readiness probe is a request for
an unknown `Host` that must answer 403 `SITE_MISSING` (it needs the database to say so).
The image declares no `HEALTHCHECK`, runs as **root** and sets only `NODE_ENV`.

Variables the platform must set (`REQUIRED_ENV`), and what leaving one out does (`env.missing.*`):

| Variable | Left out |
| --- | --- |
| `LOCAL_STORAGE_PATH`, `LOCAL_STORAGE_HOSTING_URL` | the process exits at boot (it falls back to a cloud bucket and fails) |
| `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | stays up, `/ping` is 200, every route that needs the database answers 500 |
| `MYSQL_PORT`, `NODE_ENV` | still works; `NODE_ENV` unset is treated as a non-local environment, but set it to `production` |

### 2. The database

- The migrate image runs `migrate up` and applies 84 migrations to 23 tables (`migrate.tables`).
  It reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, or one DSN in `MYSQL_DB`; both
  forms work. A second run changes nothing. Its working directory is `/`, it runs as root.
- **Migrate needs ten privileges**, and taking away any one makes it fail
  (`migrate.privilege_necessity`): `ALTER`, `CREATE`, `CREATE TEMPORARY TABLES`, `DELETE`, `DROP`,
  `INDEX`, `INSERT`, `REFERENCES`, `SELECT`, `UPDATE` on the `activitypub` schema. The one that is
  easy to forget is `CREATE TEMPORARY TABLES`.
- **The service needs rows only**: `SELECT`, `INSERT`, `UPDATE`, `DELETE`. With those it registers
  a site and runs; with `SELECT` alone registration answers 500 and writes nothing.
- Character set `utf8mb4`, collation `utf8mb4_0900_ai_ci` (the server default of both images);
  every table and column the migrations create carries that collation.
- It ran against MySQL 8.4.13 and Percona 8.0.46: the same migrations, the same 23 tables, the
  service up. 8.0 is the platform's.
- Connections: the pool holds one when idle, and about ten under 24 parallel workers. The
  default cap is 200 (read from the source and the upstream document) and the platform database's `max_connections` is 151, so set
  `MYSQL_CONN_POOL_MAX`: with it at 3 the peak was 3 with no failed request, with the default
  it was 9 to 11 under the same load.

### 3. Routes and who may call them

The table rows named `route ...` give the anonymous answer for a `Host` the service does not
know and for the registered one. The findings that matter:

- **Registration is not credential-free.** `GET /.ghost/activitypub/v1/site` with no token is
  403 `ROLE_MISSING`. Ghost makes the call itself at boot, with a Ghost owner identity token, at
  its own public address, and the service registers the `Host` it was sent. The response carries
  the **webhook secret**, so this route must never reach a browser.
- The service verifies the token against the key set at `https://<Host>/ghost/.well-known/jwks.json`,
  fetched at that moment. A token with another `Host` fails (`JWKS_MISSING`). So the `Host` header
  chooses which site's keys are trusted. It follows (it was not attempted) that anything which
  can reach the service with any `Host` and a key set of its own can register that name. Keep the service reachable only through the
  edge, and let the edge pass only the hostnames whose flag is on.
- Public once a site is registered: webfinger, nodeinfo, the actor, followers and outbox
  collections and `stable/client-config` answer 200 anonymously; the inbox answers 400 to an
  unsigned post; the four Ghost webhooks answer 401 unless signed with the site's secret.
- **Two routes answer for any `Host`, registered or not**, and are not behind the site check:
  `POST /.ghost/activitypub/pubsub/ghost/push` (400) and `.../pubsub/fedify/push` (429), plus
  `/ping` (200). The edge must not route them. They sit under the prefix the edge routes, so
  the edge rule has to deny them explicitly.
- A request with no `Host` is refused by the HTTP server (400). Everything else for an unknown
  `Host` is 403 `SITE_MISSING`.
- `/.ghost/activitypub/local-storage/*` answers 404 for a registered host, and 403 for an
  unknown one: the service does **not** serve files in production (see 6).

What Ghost itself calls and registers (`registration.*`, `ghost.*`): `GET /.ghost/activitypub/v1/site/`
(a 302 to the same path without the slash, so both forms are called) and four webhooks to
`/.ghost/activitypub/v1/webhooks/post/{published,unpublished,updated,deleted}`. Ghost answers
`/.ghost/activitypub/*` itself with 404: nothing in Ghost proxies these paths, so the edge
routes them, and Ghost reaches the service by its own public name.

### 4. Headers it trusts

`Host` selects the site. `X-Forwarded-Host` **rewrites the ids the service generates** (the edge
must overwrite it with the site's name or remove it). `X-Forwarded-Proto` is forced to https in
production, so it changes nothing; `X-Forwarded-For` changes no response (by the source it is read
only against an optional list of hosting-provider addresses, `GHOST_PRO_IP_ADDRESSES`, which the
platform does not set). `Accept` is overridden: every request is answered as ActivityPub JSON.

### 5. Private addresses, and what registration fetches

Registration fetches two URLs from the site, from the service's own host, over https on port 443
(production forces the scheme): `https://<Host>/ghost/.well-known/jwks.json` (to verify the
token) and `https://<Host>/ghost/api/admin/site/` (the site's UUID). The site name therefore has
to resolve, from the service host, to something that serves a certificate the service trusts, and
Ghost must answer both paths. **Registration does not refuse private addresses**: in the lab the
name resolved to a private bridge address and registration worked. The refusal is on federation
lookups: a lookup of an actor on a host that resolves to a private address makes no request in
production (`private_lookup.production.*`), and does make one with `NODE_ENV=testing` and
`ALLOW_PRIVATE_ADDRESS=true` (the control). Those two variables only act outside production.

### 6. `LOCAL_STORAGE_HOSTING_URL`

One value for the whole service, not per site: an upload for the registered site returned a file
URL beginning with whichever value the service was given (`storage.hosting_url_is_global_not_per_host`).
The file is written under `LOCAL_STORAGE_PATH` at the same relative path (`images/<id>/<id>.png`),
owned by root. The service **does not serve it** in production (404 at the path the URL names;
the source serves files only under `NODE_ENV=development`). Something else must serve the directory at the hosting
URL, on a hostname the platform chooses, and the directory must be a persistent volume the
service can write.

### 7. A restart with no queue

All state is in the database: after a restart the same site is registered and served
(`restart.site_survives`). A stop takes about nine seconds (the service waits that long on
`SIGTERM`, then exits 0): give the container a stop grace period of at least ten. No table
holds a queue of pending deliveries (`migrate.tables`; `account_delivery_backoffs` is a
per-account back-off record), the queue endpoints exist but are anonymous and do nothing useful
without a queue, and the boot log says the queue is disabled, so a delivery to a remote server
that is in flight or failing at the moment of a restart is not retried afterwards. That last
inference is read from the schema and the log, not from a forced failing delivery (see below).

### 8. Memory and CPU

One run on a laptop, Docker Desktop, arm64: idle 118 MiB and 0.01 % of a core; peak 166 MiB and
85 to 125 % of a core under 24 parallel workers asking webfinger 1500 times, no failures. The
facts hold ceilings (250 MiB idle, 400 MiB loaded, 5 % idle CPU), not these numbers.
Start to `/ping` 200 took about one second.

## Not observed here

- A delivery to a remote server that fails or is cut short by a restart (7 is inferred).
- Federation with a real remote server, signed requests from remote actors, and the Redis,
  Pub/Sub and cloud-storage paths (none of which the platform enables).
- More than one site per service, and memory growth over days.
- linux/amd64: the first run was on arm64; the CI run is the amd64 observation.

## The facts

<!-- facts:begin -->
| Key | What it says | Must be observed |
| --- | --- | --- |
| `service.image.cmd` | the service image's command starts the bundle with node | `["node", "dist/app.js"]` |
| `service.image.entrypoint` | the entrypoint is the Node base image's | `["docker-entrypoint.sh"]` |
| `service.image.workdir` | the working directory of the service image | `"/opt/activitypub"` |
| `service.image.exposed_ports` | the only port the image declares | `["8080/tcp"]` |
| `service.image.user` | the image sets no USER: the process is root unless the host sets one | `"root"` |
| `service.image.baked_env` | the only variable the image sets itself (so a host that clears it gets a non-production service) | `["NODE_ENV"]` |
| `service.image.node_version` | the Node runtime in the image | `"v26.13.1"` |
| `service.image.has_healthcheck` | the image declares no HEALTHCHECK | `false` |
| `migrate.image.cmd` | the migrate image's command applies every pending migration | `["up"]` |
| `migrate.image.entrypoint` | the migrate image has no entrypoint | `null` |
| `migrate.image.workdir` | the migrate image's working directory (migrations are at /migrations) | `"/"` |
| `migrate.image.tool_version` | the migration tool in the migrate image | `"4.20.1"` |
| `migrate.image.user` | the migrate image also runs as root unless the host sets a user | `"root"` |
| `db.percona-8.0.46.version_prefix` | the platform's own MySQL server version runs the migrate image and the service | `true` |
| `db.mysql-8.4.13.version_prefix` | the upstream project's own MySQL version, the other end of the range | `true` |
| `db.server.character_set` | the server default character set of the platform's database image | `"utf8mb4"` |
| `db.server.collation` | the server default collation of the platform's database image | `"utf8mb4_0900_ai_ci"` |
| `db.server.max_connections` | the platform database image's connection cap, which the service's pool must stay under | `151` |
| `migrate.full_privileges.exit` | the migrate image succeeds with exactly the ten privileges in MIGRATE_PRIVILEGES | `0` |
| `migrate.dsn_form.exit` | the migrate image also succeeds when given one DSN in MYSQL_DB | `0` |
| `migrate.version` | the schema version after migrating and whether it is dirty | `"84:0"` |
| `migrate.rerun.exit` | a second run of the migrate image against a migrated schema succeeds | `0` |
| `migrate.rerun.says_no_change` | and says it changed nothing | `true` |
| `migrate.table_collations` | every table collation the migrations create | `["utf8mb4_0900_ai_ci"]` |
| `migrate.column_collations` | every column collation the migrations create | `["utf8mb4_0900_ai_ci"]` |
| `migrate.tables` | the tables the migrations create | `["account_aliases", "account_delivery_backoffs", "account_moves", "account_topics", "accounts", "blocks", "bluesky_integration_account_handles", "discovery_feeds", "domain_blocks", "feeds", "follows", "ghost_ap_post_mappings", "key_value", "likes", "mentions", "notifications", "outboxes", "posts", "reposts", "schema_migrations", "sites", "topics", "users"]` |
| `migrate.privilege_necessity` | taking any one privilege away makes the migrate image fail | `{"ALTER": "required", "CREATE": "required", "CREATE TEMPORARY TABLES": "required", "DELETE": "required", "DROP": "required", "INDEX": "required", "INSERT": "required", "REFERENCES": "required", "SELECT": "required", "UPDATE": "required"}` |
| `db.mysql-8.4.13.migrate_exit` | the migrate image succeeds on MySQL 8.4 | `0` |
| `db.mysql-8.4.13.migration_version` | to the same schema version | `"84:0"` |
| `db.mysql-8.4.13.table_count` | with the same number of tables | `23` |
| `db.mysql-8.4.13.service_ping` | the service starts on it | `true` |
| `db.mysql-8.4.13.service_reaches_database` | and reaches its database (403 means the site lookup ran) | `403` |
| `db.service_dml_only.register_status` | a service account with SELECT, INSERT, UPDATE and DELETE only can register a site | `200` |
| `db.service_dml_only.sites_rows` | and the row is there | `1` |
| `db.service_select_only.register_status` | an account with SELECT only cannot (the service answers 500) | `500` |
| `db.service_select_only.sites_rows` | and no row is written | `0` |
| `db.idle_connections` | connections the service holds when idle (pool minimum 1) | at most `2` |
| `db.pool_max_3.peak_connections` | MYSQL_CONN_POOL_MAX caps connections: with 3, 24 parallel workers never exceed 3 | at most `3` |
| `db.pool_max_3.failures` | and no request fails for it | `0` |
| `service.baseline.ping` | the service started with exactly REQUIRED_ENV answers /ping | `true` |
| `service.baseline.database_route` | and reaches its database (403 SITE_MISSING for an unknown Host) | `403` |
| `service.baseline.ready_seconds` | seconds from start to /ping 200 | at most `15` |
| `service.boot.queue_line` | the boot log says the message queue is disabled | `true` |
| `service.boot.kv_store_line` | and that Fedify uses the MySQL key-value store | `true` |
| `service.boot.listen_line` | and that it listens on port 8080 on all interfaces | `true` |
| `service.boot.process_user` | the numeric user of the process | `"0"` |
| `health.ping_with_database_unreachable` | /ping still answers 200 when the database is unreachable | `200` |
| `health.database_route_with_database_unreachable` | while a route that needs the database answers 500 | `500` |
| `route.no_host_header` | a request with no Host header is refused by the HTTP server before the app | `400` |
| `route.ping_any_host` | /ping answers 200 for any Host | `200` |
| `env.missing.NODE_ENV` | the service with NODE_ENV left out | `"works"` |
| `env.missing.MYSQL_HOST` | the service with MYSQL_HOST left out | `"serves /ping, database route answers 500"` |
| `env.missing.MYSQL_PORT` | the service with MYSQL_PORT left out | `"works"` |
| `env.missing.MYSQL_USER` | the service with MYSQL_USER left out | `"serves /ping, database route answers 500"` |
| `env.missing.MYSQL_PASSWORD` | the service with MYSQL_PASSWORD left out | `"serves /ping, database route answers 500"` |
| `env.missing.MYSQL_DATABASE` | the service with MYSQL_DATABASE left out | `"serves /ping, database route answers 500"` |
| `env.missing.LOCAL_STORAGE_PATH` | the service with LOCAL_STORAGE_PATH left out | `"exits"` |
| `env.missing.LOCAL_STORAGE_HOSTING_URL` | the service with LOCAL_STORAGE_HOSTING_URL left out | `"exits"` |
| `route GET /ping` | health: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 200}` |
| `route GET /` | root: anonymous answer for an unregistered and for a registered Host | `{"registered": 302, "unregistered": 302}` |
| `route GET /.ghost/activitypub/v1/site` | registration and site data: anonymous answer for an unregistered and for a registered Host | `{"registered": 403, "unregistered": 403}` |
| `route DELETE /.ghost/activitypub/v1/site` | disable the site: anonymous answer for an unregistered and for a registered Host | `{"registered": 403, "unregistered": 403}` |
| `route GET /.well-known/webfinger?resource=acct:index@ghost.test` | webfinger: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route GET /.well-known/nodeinfo` | nodeinfo index: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route GET /.ghost/activitypub/nodeinfo/2.1` | nodeinfo: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route GET /.ghost/activitypub/users/index` | actor: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route GET /.ghost/activitypub/followers/index` | followers collection: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route GET /.ghost/activitypub/outbox/index` | outbox collection: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route POST /.ghost/activitypub/inbox/index` | personal inbox, unsigned: anonymous answer for an unregistered and for a registered Host | `{"registered": 400, "unregistered": 403}` |
| `route POST /.ghost/activitypub/inbox` | shared inbox, unsigned: anonymous answer for an unregistered and for a registered Host | `{"registered": 400, "unregistered": 403}` |
| `route GET /.ghost/activitypub/stable/client-config` | client config, no token: anonymous answer for an unregistered and for a registered Host | `{"registered": 200, "unregistered": 403}` |
| `route GET /.ghost/activitypub/v1/account/me` | own account, no token: anonymous answer for an unregistered and for a registered Host | `{"registered": 403, "unregistered": 403}` |
| `route POST /.ghost/activitypub/v1/webhooks/post/published` | Ghost webhook, unsigned: anonymous answer for an unregistered and for a registered Host | `{"registered": 401, "unregistered": 403}` |
| `route POST /.ghost/activitypub/v1/webhooks/post/unpublished` | Ghost webhook, unsigned: anonymous answer for an unregistered and for a registered Host | `{"registered": 401, "unregistered": 403}` |
| `route POST /.ghost/activitypub/v1/webhooks/post/updated` | Ghost webhook, unsigned: anonymous answer for an unregistered and for a registered Host | `{"registered": 401, "unregistered": 403}` |
| `route POST /.ghost/activitypub/v1/webhooks/post/deleted` | Ghost webhook, unsigned: anonymous answer for an unregistered and for a registered Host | `{"registered": 401, "unregistered": 403}` |
| `route POST /.ghost/activitypub/pubsub/ghost/push` | queue push endpoint: anonymous answer for an unregistered and for a registered Host | `{"registered": 400, "unregistered": 400}` |
| `route POST /.ghost/activitypub/pubsub/fedify/push` | queue push endpoint: anonymous answer for an unregistered and for a registered Host | `{"registered": 429, "unregistered": 429}` |
| `route GET /.ghost/activitypub/local-storage/images/none.png` | stored files: anonymous answer for an unregistered and for a registered Host | `{"registered": 404, "unregistered": 403}` |
| `registration.sites_row` | Ghost's own boot registers the site: one row, with a Ghost UUID and a webhook secret | `[["ghost.test", "uuid", "secret"]]` |
| `registration.service_fetches_from_site` | what the service fetches from the site to register it | `["GET /ghost/.well-known/jwks.json", "GET /ghost/api/admin/site/"]` |
| `registration.ghost_requests_to_service` | what Ghost itself calls on the service, at its own public address | `["GET /.ghost/activitypub/v1/site", "GET /.ghost/activitypub/v1/site/"]` |
| `ghost.webhooks` | the four webhooks Ghost registers for itself | `["post.deleted -> /.ghost/activitypub/v1/webhooks/post/deleted", "post.published -> /.ghost/activitypub/v1/webhooks/post/published", "post.published.edited -> /.ghost/activitypub/v1/webhooks/post/updated", "post.unpublished -> /.ghost/activitypub/v1/webhooks/post/unpublished"]` |
| `ghost.log.webhooks_in_correct_state` | Ghost logs that its webhooks are in the correct state | `true` |
| `ghost.serves_activitypub_paths_itself` | Ghost answers the federation paths itself (false: it answers 404, so nothing proxies them but the edge) | `false` |
| `auth.v1_site_anonymous` | registration with no credential is refused | `"{\"error\":\"Forbidden\",\"code\":\"ROLE_MISSING\"}"` |
| `auth.v1_site_owner_token` | registration with a Ghost owner identity token succeeds | `200` |
| `auth.v1_site_response_fields` | and returns the webhook secret, so it must never be routed to a browser | `["actorUrl", "domain", "ghost_uuid", "handle", "host", "id", "webhook_secret"]` |
| `auth.token_checked_against_host_jwks` | the token is checked against the key set of the Host in the request | `"401 {\"error\":\"Unauthorized\",\"code\":\"JWKS_MISSING\"}"` |
| `headers.actor_id` | the actor id the service generates for the site | `"https://ghost.test/.ghost/activitypub/users/index"` |
| `headers.unknown_host_answer` | a Host the service has no site for | `"{\"error\":\"Forbidden\",\"code\":\"SITE_MISSING\"}"` |
| `headers.x_forwarded_host_changes_actor_id` | X-Forwarded-Host rewrites the ids in a response, so the edge must overwrite it | `true` |
| `headers.x_forwarded_proto_changes_actor_id` | X-Forwarded-Proto does not (production forces https) | `false` |
| `headers.x_forwarded_for_changes_actor_id` | X-Forwarded-For does not | `false` |
| `headers.accept_header_forced` | the service answers every request as ActivityPub JSON whatever Accept says | `"application/activity+json"` |
| `storage.upload_status` | an authenticated image upload succeeds | `200` |
| `storage.file_url_starts_with_hosting_url` | its file URL starts with LOCAL_STORAGE_HOSTING_URL | `true` |
| `storage.file_written_under_path` | and the file is under LOCAL_STORAGE_PATH at the same relative path | `true` |
| `storage.file_served_by_service_in_production` | the service does not serve the stored file in production (404): something else must serve the directory | `404` |
| `storage.dir_owner` | the owner of the storage directory the service writes | `"root"` |
| `storage.hosting_url_is_global_not_per_host` | LOCAL_STORAGE_HOSTING_URL is one value for every site, not derived from the Host | `true` |
| `storage.upload_without.LOCAL_STORAGE_PATH` | with LOCAL_STORAGE_PATH left out | `"exits"` |
| `storage.upload_without.LOCAL_STORAGE_HOSTING_URL` | with LOCAL_STORAGE_HOSTING_URL left out | `"exits"` |
| `private_lookup.production.reached_the_site` | in production a lookup of an actor on a host that resolves to a private address is refused before any request is made | `0` |
| `private_lookup.allowed.reached_the_site` | control: the same lookup with NODE_ENV=testing and ALLOW_PRIVATE_ADDRESS=true does reach the site | at least `1` |
| `restart.stop_seconds` | seconds a stop takes: the service waits nine seconds on SIGTERM | at least `9` |
| `restart.exit_code` | and exits 0 by itself | `0` |
| `restart.ready_again` | the same container answers /ping after a start | `true` |
| `restart.site_survives` | and its site is still served (the state is in the database) | `200` |
| `resources.idle.memory_mib` | resident memory, idle, MiB | at most `250` |
| `resources.idle.cpu_percent` | CPU, idle, percent of one core | at most `5` |
| `resources.loaded.memory_mib` | peak memory under 24 parallel workers for 1500 webfinger requests, MiB | at most `400` |
<!-- facts:end -->
