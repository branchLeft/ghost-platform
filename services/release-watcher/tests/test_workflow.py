import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RUN_WORKFLOW = os.path.join(HERE, "..", "..", "..", ".github", "workflows", "release-watcher-run.yml")


class RunWorkflowTests(unittest.TestCase):
    def setUp(self):
        with open(RUN_WORKFLOW, encoding="utf-8") as handle:
            self.text = handle.read()

    def test_a_dispatch_from_a_non_main_ref_is_refused_by_a_failing_step(self):
        self.assertIn('if [ "$GITHUB_REF" != "refs/heads/main" ]', self.text)
        self.assertIn("exit 1", self.text.split("refs/heads/main")[1].split("- name:")[0])

    def test_the_watcher_writes_no_state_file_and_no_bootstrap_flag_remains(self):
        self.assertNotIn("state.json", self.text)
        self.assertNotIn("--bootstrap", self.text)


if __name__ == "__main__":
    unittest.main()
