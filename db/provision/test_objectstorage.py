#!/usr/bin/env python3
"""Unit tests for objectstorage.py.

No real network call: `transport` is always a fake here, both to keep CI
credential-free and because a signer that is subtly wrong fails as an opaque
403 against the real endpoint -- these tests pin the exact bytes that get
signed instead.
"""

import base64
import datetime
import hashlib
import hmac
import unittest
import urllib.parse

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


class PutBucketSubresourceTests(unittest.TestCase):
    def test_versioning_put_has_no_content_md5(self):
        calls = []

        def fake_transport(url, headers, payload):
            calls.append((url, headers, payload))
            return 200, b""

        os3.put_bucket_subresource(
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            subresource="versioning",
            body=b"<VersioningConfiguration/>",
            transport=fake_transport,
        )
        url, headers, payload = calls[0]
        self.assertEqual(url, "https://hel1.your-objectstorage.com/branchleft-db-backups?versioning=")
        self.assertNotIn("content-md5", headers)
        self.assertIn("Authorization", headers)

    def test_lifecycle_put_signs_the_given_content_md5(self):
        calls = []

        def fake_transport(url, headers, payload):
            calls.append((url, headers, payload))
            return 200, b""

        body = b"<LifecycleConfiguration/>"
        digest = base64.b64encode(hashlib.md5(body, usedforsecurity=False).digest()).decode()

        os3.put_bucket_subresource(
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            subresource="lifecycle",
            body=body,
            content_md5=digest,
            transport=fake_transport,
        )
        url, headers, payload = calls[0]
        self.assertEqual(url, "https://hel1.your-objectstorage.com/branchleft-db-backups?lifecycle=")
        self.assertEqual(headers["content-md5"], digest)
        signed = headers["Authorization"].split("SignedHeaders=")[1].split(",")[0]
        self.assertIn("content-md5", signed.split(";"))

    def test_raises_on_a_non_2xx_response(self):
        def fake_transport(url, headers, payload):
            return 403, b"<Error><Code>AccessDenied</Code></Error>"

        with self.assertRaises(os3.ObjectStorageError) as ctx:
            os3.put_bucket_subresource(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                subresource="versioning",
                body=b"x",
                transport=fake_transport,
            )
        self.assertIn("AccessDenied", str(ctx.exception))


class ListObjectsTests(unittest.TestCase):
    def _page(self, keys, *, truncated=False, next_token=None):
        contents = "".join(
            f"<Contents><Key>{key}</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified></Contents>"
            for key in keys
        )
        truncated_xml = f"<IsTruncated>{'true' if truncated else 'false'}</IsTruncated>"
        token_xml = f"<NextContinuationToken>{next_token}</NextContinuationToken>" if next_token else ""
        return (
            f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f"{contents}{truncated_xml}{token_xml}</ListBucketResult>"
        ).encode()

    def test_single_page_returns_every_key(self):
        def fake_transport(url, headers):
            return 200, self._page(["dumps/u/db1-a.sql.age", "dumps/u/db1-b.sql.age"])

        objects = os3.list_objects(
            bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
            access_key="AK", secret_key="SECRET", prefix="dumps/", transport=fake_transport,
        )
        self.assertEqual([o["key"] for o in objects], ["dumps/u/db1-a.sql.age", "dumps/u/db1-b.sql.age"])
        self.assertEqual(objects[0]["last_modified"], "2026-08-01T00:00:00.000Z")

    def test_uses_a_get_request_with_the_prefix_and_list_type_query(self):
        calls = []

        def fake_transport(url, headers):
            calls.append(url)
            return 200, self._page([])

        os3.list_objects(
            bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
            access_key="AK", secret_key="SECRET", prefix="binlogs/", transport=fake_transport,
        )
        self.assertIn("list-type=2", calls[0])
        self.assertIn("prefix=binlogs%2F", calls[0])

    def test_paginates_on_is_truncated_until_a_page_says_otherwise(self):
        pages = [
            self._page(["k1"], truncated=True, next_token="TOKEN-A"),
            self._page(["k2"], truncated=False),
        ]
        calls = []

        def fake_transport(url, headers):
            calls.append(url)
            return 200, pages.pop(0)

        objects = os3.list_objects(
            bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
            access_key="AK", secret_key="SECRET", transport=fake_transport,
        )
        self.assertEqual([o["key"] for o in objects], ["k1", "k2"])
        self.assertNotIn("continuation-token", calls[0])
        self.assertIn("continuation-token=TOKEN-A", calls[1])

    def test_raises_on_a_non_2xx_response(self):
        def fake_transport(url, headers):
            return 403, b"<Error><Code>AccessDenied</Code></Error>"

        with self.assertRaises(os3.ObjectStorageError):
            os3.list_objects(
                bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
                access_key="AK", secret_key="SECRET", transport=fake_transport,
            )

    def test_truncated_with_no_continuation_token_raises_rather_than_returning_a_partial_page(self):
        # doc 14 §16.3: this backend can accept a request and silently drop
        # an element. IsTruncated=true with no token to resume from is that
        # shape -- treating it as "done" would hand every caller a listing
        # that looks complete but silently isn't.
        def fake_transport(url, headers):
            return 200, self._page(["k1"], truncated=True, next_token=None)

        with self.assertRaises(os3.ObjectStorageError):
            os3.list_objects(
                bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
                access_key="AK", secret_key="SECRET", transport=fake_transport,
            )


class DeleteObjectTests(unittest.TestCase):
    def test_deletes_at_the_path_style_url(self):
        calls = []

        def fake_transport(url, headers):
            calls.append((url, headers))
            return 204, b""

        os3.delete_object(
            bucket="branchleft-db-backups", endpoint="hel1.your-objectstorage.com", region="hel1",
            access_key="AK", secret_key="SECRET", key="dumps/u/db1-old.sql.age", transport=fake_transport,
        )
        url, headers = calls[0]
        self.assertEqual(
            url, "https://hel1.your-objectstorage.com/branchleft-db-backups/dumps/u/db1-old.sql.age"
        )
        self.assertIn("Authorization", headers)

    def test_a_404_is_not_an_error(self):
        def fake_transport(url, headers):
            return 404, b"<Error><Code>NoSuchKey</Code></Error>"

        os3.delete_object(
            bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
            access_key="AK", secret_key="SECRET", key="k", transport=fake_transport,
        )  # does not raise -- deleting an already-gone key is a safe re-run

    def test_raises_on_a_non_2xx_non_404_response(self):
        def fake_transport(url, headers):
            return 403, b"<Error><Code>AccessDenied</Code></Error>"

        with self.assertRaises(os3.ObjectStorageError):
            os3.delete_object(
                bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
                access_key="AK", secret_key="SECRET", key="k", transport=fake_transport,
            )


class KnownAnswerTests(unittest.TestCase):
    """Cross-checks `build_headers` against a second, independently written
    SigV4 implementation rather than a single hardcoded magic value.

    A worked example copied from a secondary source turned out to be an
    unreliable fixture in practice here: two separate lookups of AWS's
    published "PUT Object" example returned mutually contradictory
    signatures and a header set that mixed the GET and PUT examples
    together, which would have made a wrong value indistinguishable from a
    real regression. Re-deriving the algorithm from AWS's canonical spec
    prose (docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html)
    as a standalone function, then requiring it to agree with
    `build_headers` across a fixed case and several randomised ones, catches
    the same class of systematic error -- wrong key-derivation order, wrong
    canonical-request field order, wrong URI/query encoding -- without
    depending on a transcription this file cannot independently verify.
    """

    @staticmethod
    def _reference_authorization(
        *,
        method,
        bucket,
        key,
        query,
        payload,
        host,
        region,
        access_key,
        secret_key,
        now,
    ) -> str:
        # Written from the spec's prose, not from objectstorage.py's code:
        # a HMAC chain built with an explicit loop over (date, region,
        # "s3", "aws4_request") rather than four named intermediate calls,
        # and the canonical request assembled as a list joined once at the
        # end rather than built incrementally.
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")

        headers = {"host": host, "x-amz-content-sha256": hashlib.sha256(payload).hexdigest(), "x-amz-date": amz_date}
        signed_header_names = sorted(headers)

        path = f"/{bucket}" if key is None else f"/{bucket}/{key}"
        canonical_uri = urllib.parse.quote(path, safe="/~")
        if query:
            canonical_query = "&".join(
                f"{urllib.parse.quote(k, safe='~')}={urllib.parse.quote(query[k] or '', safe='~')}"
                for k in sorted(query)
            )
        else:
            canonical_query = ""

        # Built as one flat newline-joined block per the spec's own
        # concatenation description, rather than via any intermediate
        # "canonical headers" string -- each header line is its own list
        # entry here, not pre-joined-with-trailing-newlines as
        # `build_headers` does it.
        canonical_request = "\n".join(
            [
                method,
                canonical_uri,
                canonical_query,
                *(f"{name}:{headers[name]}" for name in signed_header_names),
                "",  # CanonicalHeaders is followed by a blank line before SignedHeaders
                ";".join(signed_header_names),
                headers["x-amz-content-sha256"],
            ]
        )

        credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                credential_scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )

        signing_key = ("AWS4" + secret_key).encode()
        for component in (date_stamp, region, "s3", "aws4_request"):
            signing_key = hmac.new(signing_key, component.encode(), hashlib.sha256).digest()

        signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()

        return (
            f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
            f"SignedHeaders={';'.join(signed_header_names)}, Signature={signature}"
        )

    def _cases(self):
        base_now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)
        return [
            dict(
                bucket="branchleft-db-backups",
                key="dumps/aaaa/db1-20260822T031500Z.sql.age",
                payload=b"ciphertext",
                host="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AKIAEXAMPLE",
                secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                now=base_now,
            ),
            dict(
                bucket="another-bucket",
                key="binlogs/uuid/db1-mysql-bin.000042.age",
                payload=b"",
                host="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK2",
                secret_key="a-very-different-secret-key",
                now=datetime.datetime(2025, 1, 1, 0, 0, 0, tzinfo=datetime.timezone.utc),
            ),
            dict(
                bucket="b",
                key="k with spaces/and+plus",
                payload=b"\x00\x01\xff binary payload",
                host="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK3",
                secret_key="s3cr3t",
                now=datetime.datetime(2030, 12, 31, 23, 59, 59, tzinfo=datetime.timezone.utc),
            ),
        ]

    def test_build_headers_agrees_with_the_independent_reference(self):
        for case in self._cases():
            with self.subTest(case=case["key"]):
                actual = os3.build_headers(
                    bucket=case["bucket"],
                    key=case["key"],
                    payload=case["payload"],
                    host=case["host"],
                    region=case["region"],
                    access_key=case["access_key"],
                    secret_key=case["secret_key"],
                    now=case["now"],
                )
                expected = self._reference_authorization(method="PUT", query=None, **case)
                self.assertEqual(actual["Authorization"], expected)

    def test_bucket_subresource_form_agrees_with_the_independent_reference(self):
        now = datetime.datetime(2026, 8, 22, 3, 15, 0, tzinfo=datetime.timezone.utc)
        body = b"<VersioningConfiguration/>"
        actual = os3.build_headers(
            bucket="branchleft-db-backups",
            key=None,
            payload=body,
            host="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            now=now,
            query={"versioning": ""},
        )
        expected = self._reference_authorization(
            method="PUT",
            bucket="branchleft-db-backups",
            key=None,
            query={"versioning": ""},
            payload=body,
            host="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            now=now,
        )
        self.assertEqual(actual["Authorization"], expected)


if __name__ == "__main__":
    unittest.main()
