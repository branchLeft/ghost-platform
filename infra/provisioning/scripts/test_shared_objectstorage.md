# test_shared_objectstorage.py

## Module overview

`test_objectstorage.py` (in db/provision/) already proves the signing logic
itself. `shared_objectstorage.py` loads that file via `importlib` rather than
a normal `import` (see its own module docstring for why), which means the
functions it re-exports are NOT the same Python objects as `objectstorage`'s
own — `is` cannot tell a correct re-export apart from a broken one here, so
these tests assert observable behaviour instead: each re-exported operation
signs the request, reaches the given transport, and raises
`shared.ObjectStorageError` on the same conditions `objectstorage.py` does.
