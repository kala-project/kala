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
        (self.root / 'dashboard.settings.json').write_text(json.dumps({'Dashboard': {
            'Frontend': {'AuthMode': 'BrowserToken'}, 'Otlp': {'AuthMode': 'ApiKey'}, 'Api': {'AuthMode': 'ApiKey'}},
            'AllowedHosts': 'localhost;127.0.0.1;observability-dashboard'}))
        (self.root / 'otel-collector.yaml').write_text(
            'bearertokenauth/ingest\nmemory_limiter\nsend_batch_max_size:\nqueue_size:\nmax_elapsed_time:\n'
            'x-otlp-api-key:\ncompression: none\nencoding: proto\n')
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
            'KALA_OTEL_INGEST_TOKEN': 'i' * 64, 'KALA_ASPIRE_DASHBOARD_OTLP_API_KEY': 'o' * 64}
        self.services['otel-collector']['volumes'] = [mount('otel-collector.yaml', '/etc/otelcol-contrib/config.yaml', True)]
        for name in ('gateway', 'runtime'):
            self.services[name]['environment'] = {
                'KALA_OTEL_ENABLED': '1', 'KALA_OTEL_EXPORTER_ENDPOINT': 'http://otel-collector:4318',
                'KALA_OTEL_EXPORTER_TOKEN': 'i' * 64}
            self.services[name]['depends_on'] = {
                'observability-readiness': {'condition': 'service_completed_successfully'}}

    def check(self):
        result = SimpleNamespace(returncode=0, stdout=json.dumps({'services': self.services}))
        with patch.object(verify.subprocess, 'run', return_value=result):
            verify.check(self.root / 'compose.yaml', self.root / 'published.env')

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
        with self.assertRaisesRegex(ValueError, 'reviewed six-service or nine-service'):
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

    def test_unmonitored_or_disabled_health_checks_cannot_claim_waited_readiness(self):
        del self.services['runtime']['healthcheck']
        with self.assertRaisesRegex(ValueError, 'bounded executable health check'):
            self.check()
        self.services['runtime']['healthcheck'] = {'test': ['NONE'], 'disable': True}
        with self.assertRaisesRegex(ValueError, 'bounded executable health check'):
            self.check()


if __name__ == '__main__':
    unittest.main()
