#!/bin/sh
# Shared shell helpers for the live content-policy gates (POSIX sh, sourced,
# never run). One home for the Ghost container's arguments and the readiness
# wait, so csp-regression-gate.sh and csp-checkout-gate.sh cannot drift apart
# on how the Ghost under test is configured. csp/proof/run-proof.sh predates
# this file and keeps its own copy (a follow-up unifies it).

wait_for() { # description, deadline-seconds, command...
    desc="$1"; secs="$2"; shift 2
    deadline=$(($(date +%s) + secs))
    until "$@" 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "FAILED: $desc not ready within ${secs}s" >&2
            exit 2
        fi
        sleep 1
    done
}

# The pinned Ghost under test, in the shape every live gate runs it: sqlite,
# local scanning storage, self-hosted widget bundles so Portal never reaches a
# third-party origin. Anything a particular gate adds (mail, Stripe) goes in as
# extra `docker run` arguments after the four fixed ones.
ghost_start() { # name, network, public-origin, image, [extra docker args...]
    _name="$1"; _net="$2"; _origin="$3"; _image="$4"; shift 4
    docker run -d --name "$_name" --network "$_net" \
        -e url="$_origin" \
        -e database__client=sqlite3 \
        -e database__connection__filename=/var/lib/ghost/content/data/ghost-csp-gate.db \
        -e privacy__useUpdateCheck=false \
        -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
        -e storage__images__adapter=ScanningStorageAdapter \
        -e storage__images__wraps=LocalImagesStorage \
        -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
        -e storage__media__adapter=ScanningStorageAdapter \
        -e storage__media__wraps=LocalMediaStorage \
        -e storage__media__quarantinePath=/var/lib/ghost/content/quarantine \
        -e storage__files__adapter=ScanningStorageAdapter \
        -e storage__files__wraps=LocalFilesStorage \
        -e storage__files__quarantinePath=/var/lib/ghost/content/quarantine \
        -e storage__images__verdictSource=in-process-fake \
        -e storage__media__verdictSource=in-process-fake \
        -e storage__files__verdictSource=in-process-fake \
        -e logging__transports='["stdout"]' \
        -e portal__url="$_origin/bl-assets/portal.min.js" \
        -e sodoSearch__url="$_origin/bl-assets/sodo-search.min.js" \
        -e sodoSearch__styles="$_origin/bl-assets/sodo-search.min.css" \
        "$@" "$_image" >/dev/null
}
