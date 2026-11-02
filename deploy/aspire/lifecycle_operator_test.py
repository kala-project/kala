#!/usr/bin/env python3
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

import lifecycle_operator as op


class LifecycleArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)

    def tearDown(self):
        self.temp.cleanup()

    def roots(self):
        roots = {}
        for name in ("postgres", "silo", "recovery", "caddy-data", "caddy-config"):
            root = self.root / name
            root.mkdir(mode=0o755 if name.startswith("caddy-") else 0o700)
            roots[name] = root
        (roots["postgres"] / "PG_VERSION").write_bytes(b"16\n")
        (roots["postgres"] / "base").mkdir()
        (roots["postgres"] / "base" / "row").write_bytes(b"postgres-bytes\x00\xff")
        (roots["silo"] / "versions").mkdir()
        (roots["silo"] / "versions" / "object-v1").write_bytes(b"old")
        (roots["silo"] / "versions" / "object-v2").write_bytes(b"new")
        (roots["silo"] / "current").symlink_to("versions/object-v2")
        (roots["recovery"] / "installation_id").write_text("00000000-0000-4000-8000-000000000001\n")
        (roots["recovery"] / "state_key").write_bytes(b"x" * 32)
        (roots["caddy-data"] / "pki").mkdir()
        (roots["caddy-data"] / "pki" / "root.key").write_bytes(b"private-ca-key\x00\xff")
        (roots["caddy-config"] / "autosave.json").write_bytes(b'{"apps":{}}')
        for root in roots.values():
            for path in root.rglob("*"):
                if not path.is_symlink():
                    os.chmod(path, 0o700 if path.is_dir() else 0o600)
        os.chmod(roots["caddy-data"], 0o755)
        os.chmod(roots["caddy-config"], 0o755)
        return roots

    def metadata(self):
        return {"sourceVolumeProvenance": {
            "caddy-data": {"project": "fixture", "logicalName": "caddy-data", "volumeName": "fixture-caddy-data", "target": "/data", "driver": "local"},
            "caddy-config": {"project": "fixture", "logicalName": "caddy-config", "volumeName": "fixture-caddy-config", "target": "/config", "driver": "local"},
        }}

    def test_complete_artifact_validates_and_extracts_exact_bytes(self):
        roots = self.roots()
        artifact = self.root / "artifact"
        manifest = op.create_artifact(artifact, roots, {**self.metadata(),
            "images": {name: f"example/{name}@sha256:" + "a" * 64 for name in op.SERVICES},
            "postgresMajor": "16", "installationIdSha256": "i", "stateMasterKeySha256": "k",
        })
        self.assertTrue((artifact / "COMPLETED").is_file())
        self.assertFalse((self.root / "artifact.incomplete").exists())
        members, records = op.validate_archive(manifest, artifact / "payload.tar")
        self.assertEqual(len(members), len(manifest["entries"]))
        destinations = {}
        for name in roots:
            destinations[name] = self.root / f"restored-{name}"
            destinations[name].mkdir(mode=0o700)
        op.extract_archive(artifact / "payload.tar", destinations, records)
        self.assertEqual((destinations["postgres"] / "base" / "row").read_bytes(), b"postgres-bytes\x00\xff")
        self.assertEqual((destinations["silo"] / "versions" / "object-v1").read_bytes(), b"old")
        self.assertEqual(os.readlink(destinations["silo"] / "current"), "versions/object-v2")
        self.assertEqual((destinations["caddy-data"] / "pki" / "root.key").read_bytes(), b"private-ca-key\x00\xff")
        self.assertEqual(stat.S_IMODE(destinations["caddy-data"].stat().st_mode), 0o755)
        file_record = next(item for item in manifest["entries"] if item["name"] == "silo/versions/object-v2")
        self.assertEqual(file_record["sha256"], hashlib.sha256(b"new").hexdigest())

    def test_existing_artifact_or_incomplete_is_never_overwritten(self):
        roots = self.roots()
        artifact = self.root / "artifact"
        artifact.mkdir()
        with self.assertRaisesRegex(op.OperatorError, "never overwritten"):
            op.create_artifact(artifact, roots, self.metadata())

    def test_escaping_source_symlink_is_rejected(self):
        roots = self.roots()
        (roots["silo"] / "escape").symlink_to("../../outside")
        with self.assertRaisesRegex(op.OperatorError, "escaping"):
            op.create_artifact(self.root / "artifact", roots, self.metadata())
        self.assertTrue((self.root / "artifact.incomplete").is_dir())

    def test_archive_traversal_member_is_rejected(self):
        payload = self.root / "bad.tar"
        data = b"bad"
        with tarfile.open(payload, "w") as tar:
            info = tarfile.TarInfo("postgres/../escape")
            info.size = len(data); info.mode = 0o600
            tar.addfile(info, io.BytesIO(data))
        with self.assertRaisesRegex(op.OperatorError, "traversal"):
            op.normalized_member("postgres/../escape")

    def test_checksum_tamper_is_rejected(self):
        roots = self.roots()
        artifact = self.root / "artifact"
        manifest = op.create_artifact(artifact, roots, self.metadata())
        record = next(item for item in manifest["entries"] if item.get("type") == "file")
        record["sha256"] = "0" * 64
        with self.assertRaisesRegex(op.OperatorError, "checksum mismatch"):
            op.validate_archive(manifest, artifact / "payload.tar")


class LifecycleIntegrationBoundaryTests(unittest.TestCase):
    def test_authority_fingerprint_ignores_relocation_but_rejects_credential_change(self):
        config = {"services": {name: {"environment": {key: "synthetic-value" for key in keys}}
                               for name, keys in op.AUTHORITY_ENV.items()}}
        before = op.authority_configuration_sha256(config)
        config["services"]["gateway"]["environment"]["KALA_PUBLIC_URLS"] = "https://relocated.invalid"
        self.assertEqual(op.authority_configuration_sha256(config), before)
        config["services"]["gateway"]["environment"]["KALA_INGRESS_SESSION_SECRET"] = "different-value"
        self.assertNotEqual(op.authority_configuration_sha256(config), before)
        del config["services"]["postgres"]["environment"]["POSTGRES_PASSWORD"]
        with self.assertRaisesRegex(op.OperatorError, "authority credentials"):
            op.authority_configuration_sha256(config)

    def test_staged_configuration_is_not_deployed_provenance(self):
        config = {"services": {name: {"image": "example/fixture@sha256:" + "a" * 64,
                    "environment": {key: "synthetic-value" for key in keys}}
                    for name, keys in op.AUTHORITY_ENV.items()}}
        documents = {name: {"image": service["image"], "env": [key + "=" + value for key, value in service["environment"].items()]}
                     for name, service in config["services"].items()}
        def inspect(command, **kw):
            return subprocess.CompletedProcess(command, 0, json.dumps(documents[command[-1]]), "")
        with mock.patch.object(op, "container_ids", return_value={name: name for name in documents}), \
             mock.patch.object(op, "run", side_effect=inspect):
            op.verify_deployed_configuration(Path("/compose"), Path("/env"), config)
            documents["postgres"]["image"] = "different@sha256:" + "b" * 64
            with self.assertRaisesRegex(op.OperatorError, "deployed images differ"):
                op.verify_deployed_configuration(Path("/compose"), Path("/env"), config)
            documents["postgres"]["image"] = config["services"]["postgres"]["image"]
            documents["postgres"]["env"] = ["POSTGRES_DB=changed", "POSTGRES_USER=changed", "POSTGRES_PASSWORD=changed"]
            with self.assertRaisesRegex(op.OperatorError, "deployed authority credentials differ"):
                op.verify_deployed_configuration(Path("/compose"), Path("/env"), config)

    def test_observability_is_stopped_before_data_authorities(self):
        commands = []
        with mock.patch.object(op, "run", side_effect=lambda command, **kw: commands.append(command)), \
             mock.patch.object(op, "assert_inactive"), \
             mock.patch.object(op, "container_ids", return_value={"postgres": "p", "silo": "s"}), \
             mock.patch.object(op, "verify_clean_data_stop"):
            op.cold_stop(Path("/compose"), Path("/env"), 30, op.ALL_SERVICES)
        self.assertEqual(set(commands[2][-3:]), op.OBSERVABILITY)
        self.assertEqual(commands[3][-2:], ["postgres", "silo"])

    @unittest.skipUnless(os.geteuid() == 0, "distinct-container-UID recovery requires root")
    def test_restore_preserves_top_level_container_uid_not_empty_destination_uid(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            original = parent / "original"; original.mkdir(mode=0o700)
            (original / "data").write_bytes(b"persistent-data")
            os.chown(original, 70, 1000)
            os.chown(original / "data", 70, 1000)
            roots = {"postgres": original}
            for name in ("silo", "recovery", "caddy-data", "caddy-config"):
                roots[name] = parent / name; roots[name].mkdir(mode=0o700)
            metadata = {"sourceVolumeProvenance": {
                "caddy-data": {"project": "fixture", "logicalName": "data", "volumeName": "fixture-data", "target": "/data", "driver": "local"},
                "caddy-config": {"project": "fixture", "logicalName": "config", "volumeName": "fixture-config", "target": "/config", "driver": "local"}}}
            manifest = op.create_artifact(parent / "artifact", roots, metadata)
            _, records = op.validate_archive(manifest, parent / "artifact/payload.tar")
            destinations = {}
            for name in roots:
                destinations[name] = parent / f"restored-{name}"; destinations[name].mkdir(mode=0o700)
            restored = destinations["postgres"]
            op.extract_archive(parent / "artifact/payload.tar", destinations, records)
            self.assertEqual((restored.stat().st_uid, restored.stat().st_gid), (70, 1000))
            self.assertEqual((restored / "data").read_bytes(), b"persistent-data")


class LifecyclePolicyAndStopTests(unittest.TestCase):
    def test_policy_refuses_unreviewed_migration(self):
        images = {name: f"example/{name}@sha256:" + "b" * 64 for name in op.SERVICES}
        policy = {"schemaVersion": 1, "reviewId": "reviewed", "predecessorImages": images,
                  "targetImages": images, "postgresMajor": "16", "migrationMode": "run-arbitrary-command"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_text(json.dumps(policy)); os.chmod(path, 0o600)
            with mock.patch.object(op, "private_regular", return_value=path):
                with self.assertRaisesRegex(op.OperatorError, "refuses schema migration"):
                    op.load_policy(path)

    def test_cold_stop_orders_ingress_apps_then_data(self):
        commands = []
        def fake_run(command, **_kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")
        with mock.patch.object(op, "run", side_effect=fake_run), \
             mock.patch.object(op, "assert_inactive"), \
             mock.patch.object(op, "container_ids", return_value={"postgres": "p", "silo": "s"}), \
             mock.patch.object(op, "verify_clean_data_stop"):
            op.cold_stop(Path("/compose"), Path("/env"), 30)
        stop_commands = [command for command in commands if "stop" in command]
        self.assertEqual(stop_commands[0][-1], "ingress")
        self.assertEqual(stop_commands[1][-3:], list(op.APP_SERVICES))
        self.assertEqual(stop_commands[2][-2:], ["postgres", "silo"])

    def test_sigkill_style_postgres_exit_is_not_accepted(self):
        state = json.dumps({"Running": False, "Paused": False, "Restarting": False,
                            "OOMKilled": False, "ExitCode": 137})
        completed = subprocess.CompletedProcess(["docker"], 0, state, "")
        with mock.patch.object(op, "run", return_value=completed):
            with self.assertRaisesRegex(op.OperatorError, "did not shut down cleanly"):
                op.verify_clean_data_stop({"postgres": "container"})

    def test_restarting_and_paused_are_active(self):
        rows = op.parse_ps('\n'.join([
            json.dumps({"Service": "runtime", "State": "running", "Status": "Restarting (1)"}),
            json.dumps({"Service": "gateway", "State": "paused", "Status": "Paused"}),
        ]))
        self.assertEqual(op.service_state(rows["runtime"]), "restarting")
        self.assertEqual(op.service_state(rows["gateway"]), "paused")

    def test_restore_requires_explicit_fencing_acknowledgement_first(self):
        args = argparse.Namespace(acknowledge_source_fenced=False)
        with self.assertRaisesRegex(op.OperatorError, "acknowledge-source-fenced"):
            op.restore(args)


if __name__ == "__main__":
    unittest.main()
