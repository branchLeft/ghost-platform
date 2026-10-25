"""The NotPrincipal probe must refuse a foreign key that sits in another account.

A key in another account is denied by the account boundary whatever the policy
says, so a probe that does not compare accounts would read a stored-but-ignored
statement as an exemption. These tests pin the account check before any write.
"""

from __future__ import annotations

import unittest

from test_verify_bucket_fence import (
    ACCESS_DENIED_OBJECT,
    ACCOUNT,
    EMPTY_VERSIONS,
    INVALID_ACCESS_KEY,
    NO_CONTENT,
    NO_SUCH_BUCKET_POLICY,
    OBJECT_BYTES,
    OK_EMPTY,
    OTHER_OWNER,
    OWNER,
    FENCED,
    run,
)

WRITE_OPERATIONS = ("put-object", "put-bucket-policy")


def answers_for(foreign_list_buckets, operator_read, foreign_read):
    """The NotPrincipal probe's answers, with the foreign key's account made explicit."""
    return {
        ("operator", "list-buckets", None): OWNER,
        ("foreign", "list-buckets", None): foreign_list_buckets,
        ("operator", "get-bucket-policy", FENCED): NO_SUCH_BUCKET_POLICY,
        ("operator", "put-object", FENCED): OK_EMPTY,
        ("operator", "put-bucket-policy", FENCED): OK_EMPTY,
        ("operator", "delete-bucket-policy", FENCED): NO_CONTENT,
        ("operator", "get-object", FENCED): operator_read,
        ("foreign", "get-object", FENCED): foreign_read,
        ("operator", "list-object-versions", FENCED): EMPTY_VERSIONS,
    }


def rows_starting_with(output, status):
    return [line for line in output.splitlines() if line.startswith(status)]


def writes_made(transport):
    return [call for call in transport.calls if call[1] in WRITE_OPERATIONS]


class TestNotPrincipalProbeForeignAccount(unittest.TestCase):
    """The account check that stops the probe before anything is written."""

    def test_a_foreign_key_in_another_account_fails_critically(self):
        """A foreign key in another account is a critical FAIL row naming the operator's account."""
        code, output, _ = run(
            answers_for(OTHER_OWNER, OBJECT_BYTES, ACCESS_DENIED_OBJECT),
            extra_args=["--probe-notprincipal"],
        )
        self.assertEqual(code, 1, output)
        fail_rows = rows_starting_with(output, "FAIL")
        account_rows = [line for line in fail_rows if "the foreign credential is in the operator's account" in line]
        self.assertEqual(len(account_rows), 1, output)
        self.assertIn(ACCOUNT, account_rows[0])
        self.assertIn("denied by the account boundary", account_rows[0])
        self.assertIn("DO NOT APPLY THE REAL FENCE", output)
        self.assertNotIn("NotPrincipal EXEMPTS", output)
        self.assertNotIn("NotPrincipal DENIES", output)

    def test_a_foreign_key_in_another_account_writes_nothing(self):
        """No object or policy write is sent when the foreign key is in another account."""
        _, _, transport = run(
            answers_for(OTHER_OWNER, OBJECT_BYTES, ACCESS_DENIED_OBJECT),
            extra_args=["--probe-notprincipal"],
        )
        self.assertEqual(writes_made(transport), [])

    def test_an_unresolvable_foreign_account_is_inconclusive_critically(self):
        """A foreign key whose account cannot be resolved is a critical INCONCLUSIVE row."""
        code, output, transport = run(
            answers_for(INVALID_ACCESS_KEY, OBJECT_BYTES, ACCESS_DENIED_OBJECT),
            extra_args=["--probe-notprincipal"],
        )
        self.assertEqual(code, 1, output)
        inconclusive_rows = rows_starting_with(output, "INCONCLUSIVE")
        self.assertEqual(
            len([line for line in inconclusive_rows if "foreign credential resolves its account" in line]),
            1,
            output,
        )
        self.assertIn("DO NOT APPLY THE REAL FENCE", output)
        self.assertEqual(writes_made(transport), [])

    def test_a_foreign_key_in_the_same_account_still_passes(self):
        """A foreign key in the operator's account keeps both NotPrincipal rows as PASS."""
        code, output, _ = run(
            answers_for(OWNER, OBJECT_BYTES, ACCESS_DENIED_OBJECT),
            extra_args=["--probe-notprincipal"],
        )
        self.assertEqual(code, 0, output)
        pass_rows = rows_starting_with(output, "PASS")
        self.assertTrue(any("NotPrincipal EXEMPTS" in line for line in pass_rows), output)
        self.assertTrue(any("NotPrincipal DENIES" in line for line in pass_rows), output)


if __name__ == "__main__":
    unittest.main()
