"""The repository's one SigV4 implementation, reachable from this tree.
Imported by path from `db/provision/objectstorage.py` rather than moved or
copied, since `db/provision/` ships standalone to db1 via `scp -r` and two
copies of a security-sensitive signing implementation is how one silently
rots while the tests keep passing against the other.
See shared_objectstorage.md#module-overview.
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
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        # A corrupt or truncated file raises SyntaxError, not ImportError, and
        # the caller refuses on ImportError alone. Both mean the same thing to
        # an operator -- the signing is not usable -- and both must produce the
        # same one-line refusal rather than a traceback.
        raise ImportError(f"{_SOURCE} could not be executed: {error!r}") from error
    return module


_module = _load()

SOURCE = _SOURCE
ObjectStorageError = _module.ObjectStorageError
build_headers = _module.build_headers
parse_owner_id = _module.parse_owner_id
request_url = _module.request_url
signed_request = _module.signed_request
urllib_request = _module.urllib_request
delete_object = _module.delete_object
get_object = _module.get_object
get_object_with_content_type = _module.get_object_with_content_type
list_objects = _module.list_objects
put_object = _module.put_object
