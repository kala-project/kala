#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import lifecycle_operator as op


class CaddySiloRouteTests(unittest.TestCase):
    def test_silo_console_is_fenced_before_subpath_rewrite_and_private_proxy(self):
        config = (Path(__file__).parent / "Caddyfile").read_text()
        silo = config.split("@silo path /silo /silo/*", 1)[1].split("\n\thandle {", 1)[0]
        self.assertLess(silo.index("forward_auth gateway:13001"), silo.index("uri strip_prefix /silo"))
        self.assertLess(silo.index("uri strip_prefix /silo"), silo.index("reverse_proxy silo:9001"))
        self.assertIn("uri /auth/silo/authorize", silo)
        self.assertIn("header_up Cookie", silo)
        self.assertIn("stream_timeout 5m", silo)
        self.assertNotIn("reverse_proxy silo:9000", config)


class CaddyVolumeContractTests(unittest.TestCase):
    def config(self):
        services = {name: {"volumes": []} for name in op.SERVICES}
        services["ingress"]["volumes"] = [
            {"type": "bind", "source": "/protected/Caddyfile", "target": "/etc/caddy/Caddyfile"},
            {"type": "volume", "source": "caddy-data", "target": "/data"},
            {"type": "volume", "source": "caddy-config", "target": "/config"},
        ]
        return {
            "name": "reviewed-project",
            "services": services,
            "volumes": {
                "caddy-data": {"name": "reviewed-project-caddy-data", "driver": "local"},
                "caddy-config": {"name": "reviewed-project-caddy-config", "driver": "local"},
            },
        }

    def test_exact_two_ingress_volumes_are_resolved(self):
        specs = op.caddy_volume_specs(self.config())
        self.assertEqual(specs["caddy-data"]["volumeName"], "reviewed-project-caddy-data")
        self.assertEqual(specs["caddy-config"]["target"], "/config")

    def test_volume_alias_into_application_is_rejected(self):
        config = self.config()
        config["services"]["runtime"]["volumes"] = [
            {"type": "volume", "source": "caddy-data", "target": "/stolen"}
        ]
        with self.assertRaisesRegex(op.OperatorError, "only mount"):
            op.caddy_volume_specs(config)

    def test_remote_driver_options_and_traversal_names_are_rejected(self):
        config = self.config()
        config["volumes"]["caddy-data"]["driver_opts"] = {"type": "nfs"}
        with self.assertRaisesRegex(op.OperatorError, "local-driver"):
            op.caddy_volume_specs(config)
        config = self.config()
        config["volumes"]["caddy-data"]["name"] = "../host"
        with self.assertRaisesRegex(op.OperatorError, "safe Docker volume name"):
            op.caddy_volume_specs(config)

    def test_local_volume_root_accepts_0755_but_requires_compose_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            docker_root = Path(directory)
            mountpoint = docker_root / "volumes" / "reviewed-project-caddy-data" / "_data"
            mountpoint.mkdir(parents=True, mode=0o755)
            os.chmod(mountpoint, 0o755)
            spec = op.caddy_volume_specs(self.config())["caddy-data"]
            document = {
                "Name": spec["volumeName"], "Driver": "local", "Scope": "local", "Options": None,
                "Mountpoint": str(mountpoint),
                "Labels": {"com.docker.compose.project": spec["project"],
                           "com.docker.compose.volume": spec["logicalName"]},
            }
            self.assertEqual(op.validated_volume_root(document, spec, docker_root), mountpoint)
            document["Labels"]["com.docker.compose.project"] = "other-project"
            with self.assertRaisesRegex(op.OperatorError, "exact reviewed Compose"):
                op.validated_volume_root(document, spec, docker_root)

    def test_remote_docker_context_fails_before_data_root_access(self):
        completed = subprocess.CompletedProcess([], 0, '"tcp://remote.invalid:2376"\n', "")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(op, "run", return_value=completed):
            with self.assertRaisesRegex(op.OperatorError, "local Docker Unix-socket"):
                op.require_local_docker()

    def test_idempotent_docker_create_race_cannot_authorize_existing_volume(self):
        specs = {"caddy-data": op.caddy_volume_specs(self.config())["caddy-data"]}
        raced = {"Labels": {"com.docker.compose.project": "reviewed-project",
                             "com.docker.compose.volume": "caddy-data"}}
        with mock.patch.object(op, "run"), mock.patch.object(op, "inspect_volume", return_value=raced):
            with self.assertRaisesRegex(op.OperatorError, "raced with an existing volume"):
                op.create_fresh_caddy_volumes(specs, Path("/var/lib/docker"))


class ArtifactCompatibilityTests(unittest.TestCase):
    def test_v2_creation_refuses_silent_caddy_omission(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            roots = {}
            for name in op.LEGACY_ARCHIVE_ROOTS:
                roots[name] = parent / name
                roots[name].mkdir()
            with self.assertRaisesRegex(op.OperatorError, "roots must exactly match"):
                op.create_artifact(parent / "artifact", roots, {
                    "ingressMode": "bundled-caddy", "ingressIdentityCustody": "included-in-app-backup"
                })

    def test_legacy_v1_is_fail_closed_without_explicit_identity_reissue_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "artifact"
            artifact.mkdir(mode=0o700)
            payload = artifact / "payload.tar"
            payload.write_bytes(b"legacy-payload")
            manifest = {
                "schemaVersion": 1, "kind": "kala-dedicated-cold-backup",
                "payloadSha256": hashlib.sha256(payload.read_bytes()).hexdigest(),
            }
            encoded = (json.dumps(manifest) + "\n").encode()
            (artifact / "manifest.json").write_bytes(encoded)
            (artifact / "COMPLETED").write_text(hashlib.sha256(encoded).hexdigest() + "\n")
            os.chmod(payload, 0o600); os.chmod(artifact / "manifest.json", 0o600); os.chmod(artifact / "COMPLETED", 0o600)
            with mock.patch.object(op, "safe_root", return_value=artifact), \
                 mock.patch.object(op, "private_regular", side_effect=lambda path, _label: path):
                with self.assertRaisesRegex(op.OperatorError, "legacy artifact v1 omitted Caddy identity"):
                    op.read_artifact(artifact)
                loaded, _ = op.read_artifact(artifact, acknowledge_legacy=True)
                self.assertEqual(loaded["schemaVersion"], 1)

    def test_v2_is_still_read_as_bundled_caddy(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "artifact"
            artifact.mkdir(mode=0o700)
            payload = artifact / "payload.tar"
            payload.write_bytes(b"v2-payload")
            manifest = {"schemaVersion": 2, "kind": "kala-dedicated-cold-backup",
                        "payloadSha256": hashlib.sha256(payload.read_bytes()).hexdigest()}
            encoded = (json.dumps(manifest) + "\n").encode()
            (artifact / "manifest.json").write_bytes(encoded)
            (artifact / "COMPLETED").write_text(hashlib.sha256(encoded).hexdigest() + "\n")
            for path in artifact.iterdir():
                os.chmod(path, 0o600)
            with mock.patch.object(op, "safe_root", return_value=artifact), \
                 mock.patch.object(op, "private_regular", side_effect=lambda path, _label: path):
                loaded, _ = op.read_artifact(artifact)
            self.assertEqual(op.artifact_ingress_mode(loaded), "bundled-caddy")

    def test_bundled_restore_requires_fresh_volume_authorization_before_mutation(self):
        args = type("Args", (), {
            "acknowledge_source_fenced": True, "acknowledge_ingress_identity_reissue": False,
            "acknowledge_external_ingress_fenced": False, "create_fresh_caddy_volumes": False,
            "source_compose": "source", "source_env": "source-env", "target_compose": "target",
            "target_env": "target-env", "artifact": "artifact", "policy": "policy"})()
        services = {name: {"volumes": []} for name in op.SERVICES}
        services["gateway"]["environment"] = {"KALA_DEDICATED_INGRESS_MODE": "bundled-caddy"}
        config = {"services": services}
        manifest = {"schemaVersion": 3, "ingressMode": "bundled-caddy",
                    "ingressIdentityCustody": "included-in-app-backup"}
        with mock.patch.object(op, "private_regular", side_effect=lambda path, _label: path), \
             mock.patch.object(op, "read_artifact", return_value=(manifest, Path("payload"))), \
             mock.patch.object(op, "load_policy", return_value={}), \
             mock.patch.object(op, "compose_config", return_value=config), \
             mock.patch.object(op, "assert_inactive") as inactive:
            with self.assertRaisesRegex(op.OperatorError, "create-fresh-caddy-volumes"):
                op.restore(args)
        inactive.assert_not_called()


if __name__ == "__main__":
    unittest.main()
