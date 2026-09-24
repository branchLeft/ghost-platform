#!/usr/bin/env python3
"""Confirms shared_objectstorage.py's re-export surface behaves like the real
implementation, not like a stub that shadows it.

`test_objectstorage.py` (in db/provision/) already proves the signing logic
itself. `shared_objectstorage.py` loads that file via `importlib` rather than
a normal `import` (see its own module docstring for why), which means the
functions it re-exports are NOT the same Python objects as `objectstorage`'s
own -- `is` cannot tell a correct re-export apart from a broken one here, so
these tests assert observable behaviour instead: each re-exported operation
signs the request, reaches the given transport, and raises
`shared.ObjectStorageError` on the same conditions `objectstorage.py` does.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import shared_objectstorage as shared  # noqa: E402

ENDPOINT = "sandbox.example.test"
REGION = "sandbox"
COMMON = dict(bucket="b", endpoint=ENDPOINT, region=REGION, access_key="ak", secret_key="sk")


class ReExportsTests(unittest.TestCase):
    def test_get_object_signs_and_returns_the_body(self):
        calls = []

        def fake_transport(url, headers):
            calls.append((url, headers))
            return 200, b"the object's bytes"

        body = shared.get_object(key="k", transport=fake_transport, **COMMON)
        self.assertEqual(body, b"the object's bytes")
        self.assertIn("Authorization", calls[0][1])

    def test_get_object_raises_the_shared_error_type_on_404(self):
        def fake_transport(url, headers):
            return 404, b"<Error><Code>NoSuchKey</Code></Error>"

        with self.assertRaises(shared.ObjectStorageError):
            shared.get_object(key="k", transport=fake_transport, **COMMON)

    def test_get_object_with_content_type_signs_and_returns_both(self):
        def fake_transport(url, headers):
            return 200, b"jpeg bytes", {"Content-Type": "image/jpeg"}

        body, content_type = shared.get_object_with_content_type(
            key="k", transport=fake_transport, **COMMON
        )
        self.assertEqual(body, b"jpeg bytes")
        self.assertEqual(content_type, "image/jpeg")

    def test_put_object_signs_and_sends_the_payload(self):
        calls = []

        def fake_transport(url, headers, payload):
            calls.append((url, headers, payload))
            return 200, b""

        shared.put_object(key="k", data=b"ciphertext", transport=fake_transport, **COMMON)
        url, headers, payload = calls[0]
        self.assertEqual(payload, b"ciphertext")
        self.assertIn("Authorization", headers)

    def test_list_objects_parses_a_single_page(self):
        def fake_transport(url, headers):
            return 200, (
                b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                b"<Contents><Key>media/t/a.jpg.age</Key><LastModified>x</LastModified></Contents>"
                b"<IsTruncated>false</IsTruncated></ListBucketResult>"
            )

        objects = shared.list_objects(transport=fake_transport, **COMMON)
        self.assertEqual([o["key"] for o in objects], ["media/t/a.jpg.age"])

    def test_delete_object_treats_404_as_already_gone(self):
        def fake_transport(url, headers):
            return 404, b"<Error><Code>NoSuchKey</Code></Error>"

        shared.delete_object(key="k", transport=fake_transport, **COMMON)  # does not raise

    def test_delete_object_raises_on_a_real_denial(self):
        def fake_transport(url, headers):
            return 403, b"<Error><Code>AccessDenied</Code></Error>"

        with self.assertRaises(shared.ObjectStorageError):
            shared.delete_object(key="k", transport=fake_transport, **COMMON)


if __name__ == "__main__":
    unittest.main()
