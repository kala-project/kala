"""Topology-only regression fixtures; real publication/startup is a separate acceptance."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('aspire_verify', Path(__file__).with_name('verify-published-compose.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class PublishedTopology(unittest.TestCase):
    def setUp(self):
        self.scratch = TemporaryDirectory(prefix='kala-aspire-topology-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        for name in ['compose.yaml', 'published.env', 'deployment.json', 'key', 'installation-id', 'Caddyfile']:
            (self.root / name).write_text('fixture')
        (self.root / 'deployment.json').write_text(json.dumps({'schemaVersion': 1, 'architecture': 'platform', 'tenancy': 'single-tenant', 'runtimeProfile': 'full'}))
        (self.root / 'dashboard.settings.json').write_text(json.dumps({'Dashboard': {
            'Frontend': {'AuthMode': 'BrowserToken'}, 'Otlp': {'AuthMode': 'ApiKey'}, 'Api': {'AuthMode': 'ApiKey'}},
            'AllowedHosts': 'localhost;127.0.0.1;observability-dashboard'}))
        (self.root / 'otel-collector-caddy.yaml').write_text(
            (Path(__file__).parent / 'telemetry' / 'otel-collector-caddy.yaml').read_text())
        (self.root / 'otel-collector.yaml').write_text(
            (Path(__file__).parent / 'telemetry' / 'otel-collector.yaml').read_text())
        for name in ['pg', 'objects']:
            (self.root / name).mkdir()
        self.services = {name: {'image': 'example/fixture@sha256:' + '0' * 64,
            'healthcheck': {'test': ['CMD', 'fixture'], 'timeout': '4s', 'interval': '5s', 'retries': 12, 'start_period': '20s'}}
            for name in verify.EXPECTED}
        def mount(source, target, read_only=False):
            return {'type': 'bind', 'source': str(self.root / source), 'target': target, 'read_only': read_only}
        self.services['runtime']['volumes'] = [mount('deployment.json', '/etc/kala/deployment.json', True),
            mount('key', '/run/kala-secrets/runtime-state-master-key', True), mount('installation-id', '/run/kala-secrets/installation-id', True)]
        self.services['gateway']['volumes'] = [mount('deployment.json', '/etc/kala/deployment.json', True),
            mount('installation-id', '/run/kala-secrets/installation-id', True)]
        self.services['gateway']['environment'] = {
            'KALA_PUBLIC_URLS': 'https://example.com',
            'KALA_INGRESS_DATABASE_URL': 'postgresql://kala_gateway:gateway-role-password@postgres/runlab_control',
            'KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING':
                'postgresql://kala_runtime_reader:reader-role-password@postgres/kala_runtime',
        }
        self.services['runtime']['environment'] = {
            'KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING':
                'postgresql://kala_runtime:runtime-role-password@postgres/kala_runtime',
        }
        self.services['postgres']['environment'] = {'POSTGRES_PASSWORD': 'postgres-admin-password'}
        self.services['ingress']['volumes'] = [mount('Caddyfile', '/etc/caddy/Caddyfile', True)]
        self.services['ingress']['ports'] = [{'target': 443, 'protocol': 'tcp'}]
        self.services['postgres']['volumes'] = [mount('pg', '/var/lib/postgresql/data')]
        self.services['silo']['volumes'] = [mount('objects', '/data')]

    def enable_observability(self):
        def mount(source, target, read_only=False):
            return {'type': 'bind', 'source': str(self.root / source), 'target': target, 'read_only': read_only}
        for name in verify.OBSERVABILITY:
            self.services[name] = {
                'image': 'example/fixture@sha256:' + '0' * 64,
                'healthcheck': {'test': ['CMD', 'fixture'], 'timeout': '4s', 'interval': '5s', 'retries': 12, 'start_period': '20s'},
                'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
                'deploy': {'resources': {'limits': {'cpus': '0.5', 'memory': '256M'}}},
            }
        for name in ('observability-dashboard', 'otel-collector'):
            self.services[name]['restart'] = 'unless-stopped'
        self.services['observability-dashboard']['ports'] = [{'target': 18888, 'protocol': 'tcp', 'host_ip': '127.0.0.1'}]
        self.services['observability-dashboard']['volumes'] = [mount('dashboard.settings.json', '/etc/kala-observability/dashboard.settings.json', True)]
        self.services['observability-readiness'].update({
            'entrypoint': ['/bin/sh'], 'command': ['-c', 'curl http://observability-dashboard:18888/health http://otel-collector:13133/'],
            'restart': 'no', 'logging': {'driver': 'json-file', 'options': {'max-size': '1m', 'max-file': '1'}},
        })
        self.services['observability-dashboard']['environment'] = {
            'Dashboard__Frontend__BrowserToken': 'b' * 64, 'Dashboard__Otlp__PrimaryApiKey': 'o' * 64,
            'Dashboard__Api__PrimaryApiKey': 'o' * 64}
        self.services['otel-collector']['environment'] = {
            'KALA_OTEL_INGEST_TOKEN': 'i' * 64,
            'KALA_ASPIRE_DASHBOARD_OTLP_API_KEY': 'o' * 64,
            'KALA_OBSERVABILITY_POSTGRES_PASSWORD': 'p' * 64,
            'KALA_OBSERVABILITY_SILO_METRICS_TOKEN': 'headerpart.payloadpart.signaturepart',
        }
        self.services['otel-collector']['volumes'] = [mount('otel-collector.yaml', '/etc/otelcol-contrib/config.yaml', True)]
        self.services['otel-collector']['command'] = ['--config=/etc/otelcol-contrib/config.yaml']
        if 'ingress' in self.services:
            self.services['otel-collector']['volumes'].append(mount('otel-collector-caddy.yaml', '/etc/otelcol-contrib/caddy.yaml', True))
            self.services['otel-collector']['command'].append('--config=/etc/otelcol-contrib/caddy.yaml')
        for name in ('gateway', 'runtime'):
            self.services[name].setdefault('environment', {}).update({
                'KALA_OTEL_ENABLED': '1', 'KALA_OTEL_EXPORTER_ENDPOINT': 'http://otel-collector:4318',
                'KALA_OTEL_EXPORTER_TOKEN': 'i' * 64})
            self.services[name]['depends_on'] = {
                'observability-readiness': {'condition': 'service_completed_successfully'}}

    def enable_external_ingress(self):
        self.services.pop('ingress', None)
        if 'otel-collector' in self.services:
            self.services['otel-collector']['volumes'] = [m for m in self.services['otel-collector']['volumes'] if m['target'] != '/etc/otelcol-contrib/caddy.yaml']
            self.services['otel-collector']['command'] = ['--config=/etc/otelcol-contrib/config.yaml']
        self.services['gateway']['environment']['KALA_DEDICATED_INGRESS_MODE'] = 'external'
        self.services['gateway']['ports'] = [{'target': 13001, 'published': '13001', 'protocol': 'tcp', 'host_ip': '127.0.0.1'}]

    def check(self, compose=None):
        result = SimpleNamespace(returncode=0, stdout=json.dumps({'services': self.services}))
        with patch.object(verify.subprocess, 'run', return_value=result):
            return verify.check(compose or self.root / 'compose.yaml', self.root / 'published.env')

    def enable_bounded_execution(self):
        self.services['gateway']['environment']['KALA_DEDICATED_EXECUTION_PROFILE'] = 'bounded-v1'
        self.services['runtime']['environment'].update({
            'COPILOT_CLI_PATH': '/app/copilot-runtime/copilot-runtime',
            'TMPDIR': '/app/packages/host/.runtime-tmp',
            'KALA_RUNTIME_HOST_DATA_ROOT': '/app/packages/host/.runtime-tmp/kala'})
        for name, service in self.services.items():
            service.setdefault('deploy', {'resources': {'limits': {'cpus': '1.0', 'memory': '512M'}}})
            service.setdefault('logging', {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}})
            if name in ('runtime', 'gateway', 'dashboard'):
                service.update(user='65532:65532', read_only=True, cap_drop=['ALL'], security_opt=['no-new-privileges:true'],
                    tmpfs=['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'])
        self.services['runtime']['tmpfs'].append('/app/packages/host/.runtime-tmp:rw,noexec,nosuid,nodev,size=512m,uid=65532,gid=65532,mode=0700')

    def test_execution_profile_four_shapes_and_legacy_evidence(self):
        self.assertEqual(verify.check_execution_profile(self.services), 'legacy-unmarked')
        self.enable_bounded_execution(); self.check()
        self.enable_observability(); self.check()
        self.enable_external_ingress(); self.check()
        for name in verify.OBSERVABILITY: self.services.pop(name)
        self.check()
        self.services['gateway']['environment']['KALA_DEDICATED_EXECUTION_PROFILE'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'Unknown Dedicated execution profile'): self.check()

    def test_execution_profile_cannot_hide_unbounded_or_writable_apps(self):
        import copy
        self.enable_bounded_execution(); original = copy.deepcopy(self.services)
        bad = [('runtime', 'read_only', False), ('gateway', 'user', '0:0'), ('dashboard', 'cap_drop', []),
            ('runtime', 'security_opt', ['no-new-privileges:true', 'no-new-privileges:false']),
            ('gateway', 'privileged', True), ('gateway', 'pid', 'host'), ('runtime', 'cap_add', ['ALL']),
            ('runtime', 'tmpfs', ['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']),
            ('runtime', 'tmpfs', ['/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777']),
            ('runtime', 'tmpfs', original['runtime']['tmpfs'] + ['/app:rw,noexec,nosuid,nodev,size=64m']),
            ('runtime', 'tmpfs', [s.replace('size=512m', 'size=1g') for s in original['runtime']['tmpfs']]),
            ('runtime', 'tmpfs', [s.replace('mode=0700', 'mode=0777') for s in original['runtime']['tmpfs']])]
        for name, key, value in bad:
            with self.subTest(service=name, field=key):
                self.services = copy.deepcopy(original); self.services[name][key] = value
                with self.assertRaises(ValueError): self.check()
        for key, values in [('cpus', [0, -1, 'NaN', 'Infinity', True]), ('memory', [0, -1, 'unlimited', 2**64, True])]:
            for value in values:
                self.services = copy.deepcopy(original)
                self.services['postgres']['deploy']['resources']['limits'][key] = value
                with self.assertRaisesRegex(ValueError, 'positive finite'): self.check()
        self.services = copy.deepcopy(original)
        self.services['runtime']['environment']['COPILOT_CLI_PATH'] = '/tmp/copilot-runtime'
        with self.assertRaisesRegex(ValueError, 'immutable SDK'): self.check()

    def test_pid_finalization_is_only_additive_and_requires_intact_bundle(self):
        import copy
        import yaml
        import finalize_published_compose as publication
        self.enable_bounded_execution()
        self.assertEqual(self.check(), 'bounded-v1')
        self.services['gateway']['environment']['KALA_DEDICATED_EXECUTION_PROFILE'] = 'bounded-v2'
        source = self.root / 'template.yaml'; output = self.root / 'ready.yaml'
        document = {'services': copy.deepcopy(self.services), 'name': 'own-publication'}
        source.write_text(yaml.safe_dump(document, sort_keys=False)); original = source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'raw templates'): self.check(source)
        publication.finalize(source, output)
        finalized = yaml.safe_load(output.read_bytes()); stripped = copy.deepcopy(finalized)
        for name, service in stripped['services'].items():
            self.assertEqual(service.pop('pids_limit'), verify.PID_LIMITS[name])
            self.assertEqual(service['deploy']['resources']['limits'].pop('pids'), verify.PID_LIMITS[name])
        self.assertEqual(stripped, document)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(publication.receipt_path(output).stat().st_mode & 0o777, 0o600)
        self.services = finalized['services']
        self.assertEqual(self.check(output), 'bounded-v2')
        for invalid in (None, 0, -1, True, 513):
            self.services['runtime']['pids_limit'] = invalid
            with self.assertRaisesRegex(ValueError, 'PID budgets'): self.check(output)
        self.services['runtime']['pids_limit'] = verify.PID_LIMITS['runtime']
        frozen = output.read_bytes()
        with self.assertRaisesRegex(ValueError, 'already exists'): publication.finalize(source, output)
        self.assertEqual(output.read_bytes(), frozen)
        source.write_bytes(original + b'\n# changed after publication\n')
        with self.assertRaisesRegex(ValueError, 'intact PID-only'): self.check(output)
        source.write_bytes(original)
        output.write_bytes(frozen + b'\n# altered output\n')
        with self.assertRaisesRegex(ValueError, 'intact PID-only'): self.check(output)

    def test_pid_publication_preserves_interrupted_outputs_and_rejects_ambiguous_yaml(self):
        import yaml
        import finalize_published_compose as publication
        self.enable_bounded_execution()
        self.services['gateway']['environment']['KALA_DEDICATED_EXECUTION_PROFILE'] = 'bounded-v2'
        source = self.root / 'template.yaml'; output = self.root / 'interrupted.yaml'
        source.write_text(yaml.safe_dump({'services': self.services}))
        create = publication.create_private
        def fail_receipt(path, content):
            if path == publication.receipt_path(output): raise OSError('injected interruption')
            create(path, content)
        with patch.object(publication, 'create_private', side_effect=fail_receipt):
            with self.assertRaises(OSError): publication.finalize(source, output)
        self.assertTrue(output.is_file()); self.assertFalse(publication.receipt_path(output).exists())
        with self.assertRaises(OSError): publication.verify_receipt(output)
        with self.assertRaisesRegex(ValueError, 'already exists'): publication.finalize(source, output)
        for malformed in (b'services: {}\nservices: {}\n', b'services: &a {self: *a}\n'):
            with self.assertRaises(ValueError): publication.load_template(malformed)
        with self.assertRaises(ValueError): publication.finalize(source, self.root.parent / 'elsewhere.yaml')
        alias = self.root / 'alias.yaml'; alias.symlink_to(source)
        with self.assertRaises(ValueError): publication.finalize(alias, self.root / 'other.yaml')

    def test_only_existing_canonical_disjoint_authorities_are_accepted(self):
        self.check()
        alias = self.root / 'alias'
        alias.symlink_to(self.root / 'pg', target_is_directory=True)
        nested = self.root / 'pg' / 'nested'
        nested.mkdir()
        bad = [self.root / 'missing', self.root / 'key', alias, self.root / 'pg', nested, Path('/')]
        original = self.services['silo']['volumes'][0]['source']
        for source in bad:
            with self.subTest(source=source.name):
                self.services['silo']['volumes'][0]['source'] = str(source)
                with self.assertRaises(ValueError):
                    self.check()
        self.services['silo']['volumes'][0]['source'] = original
        self.check()

    def test_reviewed_observability_shape_accepts_only_loopback_management(self):
        self.enable_observability()
        self.check()
        self.services['observability-dashboard']['ports'][0]['host_ip'] = '0.0.0.0'
        with self.assertRaisesRegex(ValueError, 'loopback-only'):
            self.check()
        self.services['observability-dashboard']['ports'][0]['host_ip'] = '127.0.0.1'
        self.services['otel-collector']['ports'] = [{'target': 4318, 'protocol': 'tcp'}]
        with self.assertRaisesRegex(ValueError, 'unexpectedly publishes'):
            self.check()

    def test_observability_requires_authentication_limits_and_exact_shape(self):
        self.enable_observability()
        del self.services['runtime']['environment']['KALA_OTEL_EXPORTER_TOKEN']
        with self.assertRaisesRegex(ValueError, 'protected Collector and Dashboard'):
            self.check()
        self.enable_observability()
        self.services['observability-dashboard']['environment']['ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS'] = 'true'
        with self.assertRaisesRegex(ValueError, 'must not allow anonymous'):
            self.check()
        self.enable_observability()
        del self.services['otel-collector']['deploy']
        with self.assertRaisesRegex(ValueError, 'CPU and memory limits'):
            self.check()
        self.services.pop('otel-collector')
        with self.assertRaisesRegex(ValueError, 'reviewed five/six-service or eight/nine-resource'):
            self.check()

    def test_telemetry_credentials_cannot_be_reused_or_misbound(self):
        self.enable_observability()
        self.services['observability-dashboard']['environment']['Dashboard__Frontend__BrowserToken'] = 'o' * 64
        with self.assertRaisesRegex(ValueError, 'distinct strong credentials'):
            self.check()
        self.enable_observability()
        self.services['otel-collector']['environment']['KALA_OTEL_INGEST_TOKEN'] = 'wrong-ingest'
        with self.assertRaisesRegex(ValueError, 'consistent endpoint bindings'):
            self.check()
        self.enable_observability()
        self.services['otel-collector']['environment']['KALA_OBSERVABILITY_POSTGRES_PASSWORD'] = 'postgres-admin-password'
        with self.assertRaisesRegex(ValueError, 'fixed monitor authority'):
            self.check()

    def test_copilot_authentication_requires_runtime_only_explicit_credentials(self):
        self.check()  # Original unconfigured graphs remain valid.
        environment = self.services['runtime']['environment']
        environment['KALA_DEDICATED_COPILOT_AUTH_MODE'] = 'github-token'
        for token in (None, '', '  '):
            environment['COPILOT_GITHUB_TOKEN'] = token
            with self.assertRaisesRegex(ValueError, 'explicit Runtime GitHub token'):
                self.check()
        environment['COPILOT_GITHUB_TOKEN'] = 'fixture-token-not-a-real-credential'
        self.check()
        environment['KALA_DEDICATED_COPILOT_AUTH_MODE'] = 'ambient'
        with self.assertRaisesRegex(ValueError, 'explicit Runtime GitHub token'):
            self.check()
        environment['KALA_DEDICATED_COPILOT_AUTH_MODE'] = 'github-token'
        environment['GH_TOKEN'] = 'ambiguous-fixture-token'
        with self.assertRaisesRegex(ValueError, 'ambiguous fallback'):
            self.check()
        del environment['GH_TOKEN']
        for service in ('gateway', 'dashboard', 'postgres', 'silo'):
            for key in ('COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'):
                self.services[service].setdefault('environment', {})[key] = 'fixture-leak'
                with self.assertRaisesRegex(ValueError, 'only to Runtime'):
                    self.check()
                del self.services[service]['environment'][key]

    def test_external_profiles_require_explicit_custody_and_loopback_handoff(self):
        self.services.pop('ingress')
        with self.assertRaisesRegex(ValueError, 'marker must agree'):
            self.check()
        self.enable_external_ingress()
        self.check()
        self.enable_observability()
        self.check()
        self.services['gateway']['ports'][0]['host_ip'] = '0.0.0.0'
        with self.assertRaisesRegex(ValueError, 'loopback-only'):
            self.check()
        self.services['gateway']['ports'][0]['host_ip'] = '127.0.0.1'
        self.services['runtime']['volumes'].append({'type': 'volume', 'source': 'certificate-state', 'target': '/certs'})
        with self.assertRaisesRegex(ValueError, 'named application/certificate'):
            self.check()

    def test_external_tls_does_not_remove_origin_or_mode_safety(self):
        self.enable_external_ingress()
        self.services['gateway']['environment']['KALA_PUBLIC_URLS'] = 'http://example.com'
        with self.assertRaisesRegex(ValueError, 'HTTPS public Origin'):
            self.check()
        self.services['gateway']['environment']['KALA_PUBLIC_URLS'] = 'https://example.com'
        descriptor = {'schemaVersion': 1, 'architecture': 'standalone', 'tenancy': 'single-tenant', 'runtimeProfile': 'full'}
        (self.root / 'deployment.json').write_text(json.dumps(descriptor))
        with self.assertRaisesRegex(ValueError, 'Dedicated storage/tenancy'):
            self.check()

    def test_unmonitored_or_disabled_health_checks_cannot_claim_waited_readiness(self):
        del self.services['runtime']['healthcheck']
        with self.assertRaisesRegex(ValueError, 'bounded executable health check'):
            self.check()
        self.services['runtime']['healthcheck'] = {'test': ['NONE'], 'disable': True}
        with self.assertRaisesRegex(ValueError, 'bounded executable health check'):
            self.check()


if __name__ == '__main__':
    unittest.main()
