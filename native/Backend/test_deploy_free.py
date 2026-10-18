"""Local tests: no Google authentication, network requests or deployments."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import deploy_free


class CandidateDeploymentTests(unittest.TestCase):
    def options(self, *arguments):
        with patch.dict("os.environ", {}, clear=True):
            return deploy_free.parse_options(list(arguments))

    def test_candidate_has_no_traffic_and_exact_tag_without_configuration_changes(self):
        options = self.options("--no-traffic", "--tag", "review-0-17-0-20261017")
        command = deploy_free.deployment_command("gcloud", "/private/token", "/staged/source", options)
        self.assertIn("--no-traffic", command)
        self.assertEqual(command[command.index("--tag") + 1], "review-0-17-0-20261017")
        for flag in ("--set-env-vars", "--update-env-vars", "--clear-env-vars", "--set-secrets", "--clear-secrets",
                     "--service-account", "--allow-unauthenticated", "--to-latest", "--min-instances", "--max-instances"):
            self.assertNotIn(flag, command)

    def test_no_traffic_without_tag_is_supported(self):
        command = deploy_free.deployment_command("gcloud", "token", "source", self.options("--no-traffic"))
        self.assertIn("--no-traffic", command)
        self.assertNotIn("--tag", command)

    def test_tag_requires_no_traffic(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            self.options("--tag", "review")
        self.assertEqual(error.exception.code, 2)

    def test_tags_reject_invalid_and_shell_like_values(self):
        for tag in ("UPPER", "-leading", "trailing-", "a" * 64, "review;echo secret", "../other", "a.b", "1review"):
            with self.subTest(tag=tag), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.options("--no-traffic", "--tag", tag)
        for tag in ("a", "review-0", "a" * 63):
            self.assertEqual(self.options("--no-traffic", "--tag", tag).tag, tag)

    def test_explicit_properties_only_update_requested_configuration(self):
        options = self.options("--no-traffic", "--tag", "review", "--customer-bucket", "example-private-customer-bucket",
                               "--service-account", "runtime@example-project.iam.gserviceaccount.com")
        command = deploy_free.deployment_command("gcloud", "token", "source", options)
        self.assertEqual(command[command.index("--update-env-vars") + 1],
                         "CUSTOMER_BUCKET=example-private-customer-bucket,STORAGE_PROJECT_ID=gendragood-ssd")
        self.assertEqual(command[command.index("--service-account") + 1], "runtime@example-project.iam.gserviceaccount.com")
        self.assertNotIn("--set-env-vars", command)
        self.assertNotIn("--clear-secrets", command)

    def test_runtime_allowlist_excludes_credentials_private_config_and_tests(self):
        with tempfile.TemporaryDirectory(prefix="gd-deploy-test-") as folder:
            count = deploy_free.stage_runtime(folder)
            staged = Path(folder)
            self.assertGreater(count, len(deploy_free.RUNTIME_FILES))
            self.assertEqual(json.loads((staged / "package.json").read_text())["scripts"]["start"], "node free_server.js")
            for name in ("customer-storage.json", "customer-storage.example.json", "deploy_free.py", "test_deploy_free.py", "server.js", "access-token"):
                self.assertFalse((staged / name).exists())
            self.assertFalse(list(staged.rglob("*.test.js")))
            self.assertFalse((staged / "node_modules").exists())
            mapped = staged / "mobile" / "extension-map.json"
            self.assertTrue(mapped.is_file())
            self.assertFalse(mapped.is_symlink())
            self.assertEqual(mapped.read_bytes(), (deploy_free.BASE / "mobile" / "extension-map.json").resolve().read_bytes())

    def test_dry_run_does_not_authenticate_or_deploy(self):
        output = io.StringIO()
        with patch.dict("os.environ", {}, clear=True), contextlib.redirect_stdout(output), \
             patch.object(deploy_free.subprocess, "run", side_effect=AssertionError("Unexpected external operation")):
            deploy_free.main(["--no-traffic", "--tag", "review-0-17-0-20261017", "--dry-run"])
        self.assertIn("0% production traffic", output.getvalue())
        self.assertIn("Deployment was not started", output.getvalue())

    def test_existing_tag_is_not_repointed(self):
        options = self.options("--no-traffic", "--tag", "review")
        result = SimpleNamespace(returncode=0, stdout=json.dumps({"status": {"traffic": [{"tag": "review", "revisionName": "old-candidate"}]}}))
        with patch.object(deploy_free.subprocess, "run", return_value=result) as run, self.assertRaisesRegex(RuntimeError, "already exists"):
            deploy_free.ensure_new_tag("gcloud", "/private/token", options)
        self.assertIn("describe", run.call_args.args[0])
        self.assertNotIn("deploy", run.call_args.args[0])
        self.assertIn("--format=json(status.traffic)", run.call_args.args[0])

    def test_new_tag_passes_read_only_uniqueness_check(self):
        options = self.options("--no-traffic", "--tag", "review")
        result = SimpleNamespace(returncode=0, stdout=json.dumps({"status": {"traffic": [{"tag": "older-review", "revisionName": "old-candidate"}]}}))
        with patch.object(deploy_free.subprocess, "run", return_value=result):
            deploy_free.ensure_new_tag("gcloud", "/private/token", options)

    def test_tag_lookup_fails_closed_without_changing_service(self):
        options = self.options("--no-traffic", "--tag", "review")
        for result in (SimpleNamespace(returncode=1, stdout=""), SimpleNamespace(returncode=0, stdout="invalid-json")):
            with patch.object(deploy_free.subprocess, "run", return_value=result), self.assertRaises(RuntimeError):
                deploy_free.ensure_new_tag("gcloud", "/private/token", options)


if __name__ == "__main__":
    unittest.main()
