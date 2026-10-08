#!/usr/bin/env python3
"""Exit 0 only if a GitHub environment really gates its deploy job.

Usage: assert-environment-gated.py ENV_JSON RULES_JSON | --self-test
Rules and recorded API shapes: assert-environment-gated.md
"""
import json
import sys

APP_ID = 5090756
APP_SLUG = "branchleft-reviewer"


def gated(env, rules):
    """Return (ok, reason). Anything malformed is not gated, and both
    documents must be readable: one failed API call fails the guard."""
    if not isinstance(env, dict) or not isinstance(rules, dict):
        return False, "an API response was unreadable"
    if "protection_rules" not in env or "custom_deployment_protection_rules" not in rules:
        return False, "an API response lacked the expected field (error body?)"
    try:
        for rule in env["protection_rules"]:
            if rule.get("type") == "required_reviewers":
                return True, "required_reviewers rule"
    except (KeyError, TypeError, AttributeError):
        pass
    try:
        for rule in rules["custom_deployment_protection_rules"]:
            app = rule["app"]
            if (
                rule.get("enabled") is True
                and app.get("id") == APP_ID
                and app.get("slug") == APP_SLUG
            ):
                return True, "enabled %s deployment protection rule" % APP_SLUG
    except (KeyError, TypeError, AttributeError):
        pass
    return False, "no required_reviewers rule and no enabled %s rule" % APP_SLUG


# Shapes recorded from the live API (GET environments/production on
# ghost-tenant-blog, GET environments/production-demo-host on ghost-platform,
# and each one's /deployment_protection_rules), trimmed of URL fields.
ENV_REVIEWER = {"name": "production", "protection_rules": [
    {"id": 65164769, "type": "required_reviewers", "prevent_self_review": False,
     "reviewers": [{"type": "User", "reviewer": {"login": "Rob-branchLeft"}}]}]}
ENV_NONE = {"name": "production", "protection_rules": []}
ENV_BRANCH_ONLY = {"name": "production", "protection_rules": [
    {"id": 1, "type": "branch_policy"}]}
RULES_APP = {"total_count": 1, "custom_deployment_protection_rules": [
    {"id": 68095322, "enabled": True, "app": {
        "id": APP_ID, "slug": APP_SLUG,
        "integration_url": "https://api.github.com/apps/branchleft-reviewer"}}]}
RULES_APP_DISABLED = {"total_count": 1, "custom_deployment_protection_rules": [
    {"id": 68095322, "enabled": False, "app": RULES_APP[
        "custom_deployment_protection_rules"][0]["app"]}]}
RULES_OTHER = {"total_count": 1, "custom_deployment_protection_rules": [
    {"id": 7, "enabled": True, "app": {
        "id": 5, "slug": "example-app",
        "integration_url": "https://api.github.com/apps/example-app"}}]}
RULES_WRONG_ID = {"total_count": 1, "custom_deployment_protection_rules": [
    {"id": 8, "enabled": True, "app": {"id": 5, "slug": APP_SLUG}}]}
RULES_WRONG_SLUG = {"total_count": 1, "custom_deployment_protection_rules": [
    {"id": 9, "enabled": True, "app": {"id": APP_ID, "slug": "example-app"}}]}
RULES_NONE = {"total_count": 0, "custom_deployment_protection_rules": []}

CASES = [
    ("reviewer-only passes", ENV_REVIEWER, RULES_NONE, True),
    ("app-rule-only passes", ENV_NONE, RULES_APP, True),
    ("both pass", ENV_REVIEWER, RULES_APP, True),
    ("other-app-only fails", ENV_NONE, RULES_OTHER, False),
    ("right slug, wrong id fails", ENV_NONE, RULES_WRONG_ID, False),
    ("right id, wrong slug fails", ENV_NONE, RULES_WRONG_SLUG, False),
    ("disabled app rule fails", ENV_NONE, RULES_APP_DISABLED, False),
    ("branch policy only fails", ENV_BRANCH_ONLY, RULES_NONE, False),
    ("nothing fails", ENV_NONE, RULES_NONE, False),
    ("unreadable env fails", None, RULES_APP, False),
    ("unreadable rules fails", ENV_NONE, None, False),
    ("api error body fails", {"message": "Not Found"}, {"message": "Not Found"}, False),
]


def self_test():
    bad = 0
    for name, env, rules, want in CASES:
        got, _ = gated(env, rules)
        print("%s: %s" % ("ok  " if got == want else "FAIL", name))
        bad += got != want
    return 1 if bad else 0


def main(argv):
    if argv == ["--self-test"]:
        return self_test()
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1
    docs = []
    for path in argv:
        try:
            with open(path) as f:
                docs.append(json.load(f))
        except (OSError, ValueError) as exc:
            print("::error::could not read %s: %s" % (path, exc), file=sys.stderr)
            return 1
    ok, reason = gated(*docs)
    print(("gated: " if ok else "NOT gated: ") + reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
