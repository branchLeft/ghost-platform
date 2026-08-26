"""The repository's one SigV4 implementation, reachable from this tree.

`db/provision/objectstorage.py` signs every request db1's backup pipeline
makes against Hetzner Object Storage. `verify-bucket-fence.py` needs exactly
that signing, against exactly that endpoint, and imports it from here rather
than carrying a copy: two copies of a security-sensitive signing
implementation is how one of them silently rots while the tests keep passing
against the other.

IT IS IMPORTED BY PATH RATHER THAN MOVED SOMEWHERE BOTH TREES CAN SEE.
`db/RUNBOOK-db.md` provisions db1 by copying `db/provision/` to the host with
`scp -r` and running the scripts in place; the dump, binlog-shipping and prune
units all import `objectstorage` as a sibling of themselves. Relocating the
file into a shared parent would leave the next copy of that directory shipping
a module whose import is no longer beside it, and the symptom would be a backup
pipeline that stops at the next redeploy rather than a failure here.

`importlib` rather than a `sys.path` entry, so that importing this module does
not put every other file in `db/provision/` on the import path of a script that
has no business reaching them.
"""

from __future__ import annotations

import importlib.util
import pathlib

# infra/provisioning/scripts/ -> infra/provisioning/ -> infra/ -> the repo root.
_SOURCE = pathlib.Path(__file__).resolve().parents[3] / "db" / "provision" / "objectstorage.py"


def _load():
    if not _SOURCE.is_file():
        raise ImportError(
            f"the shared SigV4 implementation is not at {_SOURCE}. Every request this "
            f"verifier makes is signed by it, so nothing can run without it. Check out "
            f"the whole of branchLeft/ghost-platform rather than the scripts directory "
            f"alone."
        )
    spec = importlib.util.spec_from_file_location("branchleft_objectstorage", _SOURCE)
    if spec is None or spec.loader is None:
        raise ImportError(f"{_SOURCE} could not be loaded as a Python module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_module = _load()

SOURCE = _SOURCE
ObjectStorageError = _module.ObjectStorageError
build_headers = _module.build_headers
parse_owner_id = _module.parse_owner_id
request_url = _module.request_url
signed_request = _module.signed_request
urllib_request = _module.urllib_request
