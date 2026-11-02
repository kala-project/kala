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

    def test_unmonitored_or_disabled_health_checks_cannot_claim_waited_readiness(self):
        del self.services['runtime']['healthcheck']
        with self.assertRaisesRegex(ValueError, 'bounded executable health check'):
            self.check()
        self.services['runtime']['healthcheck'] = {'test': ['NONE'], 'disable': True}
        with self.assertRaisesRegex(ValueError, 'bounded executable health check'):
            self.check()


if __name__ == '__main__':
    unittest.main()
