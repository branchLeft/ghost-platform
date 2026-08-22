#!/usr/bin/env python3
"""Unit tests for objectstorage.py.

No real network call: `transport` is always a fake here, both to keep CI
credential-free and because a signer that is subtly wrong fails as an opaque
403 against the real endpoint -- these tests pin the exact bytes that get
signed instead.
"""

import datetime
import hashlib
import unittest

import objectstorage as os3


class BuildHeadersTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)

    def _headers(self, **overrides):
        kwargs = dict(
            bucket="branchleft-db-backups",
            key="dumps/db1-20260822T031500Z.sql.age",
            payload=b"ciphertext",
            host="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            content_type="application/octet-stream",
            now=self.now,
        )
        kwargs.update(overrides)
        return os3.build_headers(**kwargs)

    def test_signs_the_actual_payload_hash(self):
        headers = self._headers(payload=b"hello")
        self.assertEqual(
            headers["x-amz-content-sha256"], hashlib.sha256(b"hello").hexdigest()
        )

    def test_scope_uses_the_given_date_and_region(self):
        headers = self._headers()
        self.assertIn("Credential=AK/20260822/hel1/s3/aws4_request", headers["Authorization"])

    def test_amz_date_matches_now(self):
        headers = self._headers()
        self.assertEqual(headers["x-amz-date"], "20260822T031500Z")

    def test_signed_headers_cover_exactly_the_headers_sent(self):
        headers = self._headers()
        signed = headers["Authorization"].split("SignedHeaders=")[1].split(",")[0]
        self.assertEqual(signed, "content-type;host;x-amz-content-sha256;x-amz-date")

    def test_different_payloads_produce_different_signatures(self):
        sig_a = self._headers(payload=b"a")["Authorization"]
        sig_b = self._headers(payload=b"b")["Authorization"]
        self.assertNotEqual(sig_a, sig_b)

    def test_different_secret_keys_produce_different_signatures(self):
        sig_a = self._headers(secret_key="one")["Authorization"]
        sig_b = self._headers(secret_key="two")["Authorization"]
        self.assertNotEqual(sig_a, sig_b)


class PutObjectTests(unittest.TestCase):
    def test_puts_to_the_path_style_url_with_the_signed_headers(self):
        calls = []

        def fake_transport(url, headers, payload):
            calls.append((url, headers, payload))
            return 200, b""

        os3.put_object(
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            key="dumps/db1-20260822T031500Z.sql.age",
            data=b"ciphertext",
            transport=fake_transport,
        )

        self.assertEqual(len(calls), 1)
        url, headers, payload = calls[0]
        self.assertEqual(
            url,
            "https://hel1.your-objectstorage.com/branchleft-db-backups/"
            "dumps/db1-20260822T031500Z.sql.age",
        )
        self.assertIn("Authorization", headers)
        self.assertEqual(payload, b"ciphertext")

    def test_raises_on_a_non_2xx_response(self):
        def fake_transport(url, headers, payload):
            return 403, b"<Error><Code>SignatureDoesNotMatch</Code></Error>"

        with self.assertRaises(os3.ObjectStorageError) as ctx:
            os3.put_object(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                key="k",
                data=b"x",
                transport=fake_transport,
            )
        self.assertIn("SignatureDoesNotMatch", str(ctx.exception))

    def test_204_is_accepted_as_success(self):
        def fake_transport(url, headers, payload):
            return 204, b""

        os3.put_object(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            key="k",
            data=b"x",
            transport=fake_transport,
        )  # does not raise


if __name__ == "__main__":
    unittest.main()
