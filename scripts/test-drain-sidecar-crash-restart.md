# test-drain-sidecar-crash-restart.py

## What this proves

A drain-sidecar joins its Ghost's network namespace (`docker run --network
container:<ghost>`). When Docker restarts a crashed Ghost it gives it a new
namespace, and a sidecar left in the old one answers nothing for that colour
until something restarts it.

The script runs one Ghost with two sidecars beside it, kills Ghost, lets
Docker restart it, and reads the result:

- the **watched** sidecar, started the way `demo-host/provision/demo_sidecar.py`
  starts one (`--restart on-failure` and `EXIT_AFTER_GHOST_UNREACHABLE_MS`),
  must answer 200 again without anyone restarting it, and must have been
  restarted at least once;
- the **control** sidecar, started without either, must still not answer 200.
  It is what shows the test can fail: if it recovered by itself the test would
  prove nothing about the fix.

It also refuses to pass when Ghost's network namespace did not change across
the restart (the sandbox key Docker reports is compared before and after).

Ghost runs with `--restart on-failure` here, not the Compose file's
`unless-stopped`, because `docker kill` counts as a manual stop for the
latter. Both policies restart a Ghost whose process dies by itself, which is
the case this models.

## Usage

```sh
docker build -t ghost-platform:local .
docker build -t drain-sidecar:local --secret id=node_auth_token,env=NODE_AUTH_TOKEN services/drain-sidecar
python3 scripts/test-drain-sidecar-crash-restart.py drain-sidecar:local ghost-platform:local
```

Needs a local Docker daemon. It uses host ports 4220 to 4222 and removes every
container it starts, pass or fail. It runs in CI after the real-Ghost proof in
`.github/workflows/drain-sidecar-image.yml`.

## What it does not prove

The host's own units. `demo_sidecar.py` is proven by `test_demo_sidecar.py`
against a fake Docker; the sidecar digest the host runs is bumped separately,
and a host running an older digest still has the old behaviour until then.
