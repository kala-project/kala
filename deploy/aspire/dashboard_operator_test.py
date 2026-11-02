"""One real Docker protocol drill, not real Kala UI/Agent/Executor acceptance.

Uses only two pre-existing immutable Node images; never builds/pulls/prunes images.
KALA_RUN_DASHBOARD_DOCKER=1 sudo -E python3 -m unittest dashboard_operator_test.py
"""
import argparse
import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

import lifecycle_operator as op
from test_verify_published_compose import PublishedTopology

OLD = 'kala-dedicated-api-gateway@sha256:e42b057155f8f273b4066d54dd5741b47acf586f5cb35aa30e21e5adbcc7d63a'
NEW = 'kala-dedicated-parented-gateway@sha256:53b3352e4f673365cb6615a4171ec829a8c2759090af37a8e25bf4d7aade3ec5'
SCRIPT = r"""
import http from 'node:http'; import net from 'node:net'; import fs from 'node:fs'; import crypto from 'node:crypto';
const role=process.env.FIXTURE_ROLE;
const generation=crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.resolve('@agent-kernel/shared/node-telemetry')))).digest('hex');
let count=0; let unhealthy=false;
const server=http.createServer(async(req,res)=>{
 if(role==='gateway' && ['/ui','/fail-ui'].includes(req.url)) {try{const r=await fetch('http://dashboard:8080/'+(req.url==='/fail-ui'?'fail':''));res.end(await r.text());}catch{res.statusCode=503;res.end();}return;}
 if(req.url==='/fail')unhealthy=true;
 if(req.url==='/health' && unhealthy)res.statusCode=503;
 res.end(JSON.stringify({generation,role}));
});
server.on('upgrade',(req,socket,head)=>{
 if(role==='gateway'){const upstream=net.connect(13001,'runtime',()=>{upstream.write('GET /stream HTTP/1.1\r\nHost: runtime\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());}
 else {socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');socket.on('data',()=>socket.write(String(++count)+'\n'));}
});
server.listen(role==='dashboard'?8080:13001,'0.0.0.0');
"""


class DashboardAdmissionTests(unittest.TestCase):
    def test_only_dashboard_image_can_change_and_selected_context_takes_precedence(self):
        base = {'name': 'fixture', 'services': {'dashboard': {'image': OLD}, 'runtime': {'image': NEW}}}
        target = copy.deepcopy(base); target['services']['dashboard']['image'] = NEW
        args = argparse.Namespace(**{key: '/fixture' for key in ('current_compose','current_env','target_compose','target_env','policy')})
        with mock.patch.object(op, 'require_local_docker'), mock.patch.object(op, 'private_regular', side_effect=lambda path, _: path), \
             mock.patch.object(op, 'load_policy', return_value={}), mock.patch.object(op, 'run'), \
             mock.patch.object(op, 'preflight_pair', return_value=(base, target)):
            op.dashboard_pair(args)
            target['services']['runtime']['environment'] = {'CHANGED': 'yes'}
            with self.assertRaisesRegex(op.OperatorError, 'only a changed dashboard'):
                op.dashboard_pair(args)
            target['services']['runtime'].pop('environment')
            target['name'] = 'another-project'
            with self.assertRaisesRegex(op.OperatorError, 'same explicit Compose project'):
                op.dashboard_pair(args)
        with mock.patch.dict(os.environ, {'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONTEXT': 'remote'}, clear=True), \
             mock.patch.object(op, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='"ssh://remote"')):
            with self.assertRaisesRegex(op.OperatorError, 'local Docker Unix-socket'):
                op.require_local_docker()
        invalid = {'schemaVersion':1,'kind':'dedicated-dashboard-upgrade','operationId':'a'*32,'inputs':[]}
        for value in ([], invalid):
            source = mock.Mock()
            source.read_text.return_value = json.dumps(value)
            with mock.patch.object(op, 'private_regular', return_value=source):
                with self.assertRaises(op.OperatorError):
                    op.dashboard_apply(argparse.Namespace(source_receipt='/fixture'), rollback=True)


@unittest.skipUnless(os.environ.get('KALA_RUN_DASHBOARD_DOCKER') == '1', 'explicit isolated Docker gate')
class DashboardDockerProtocolTests(unittest.TestCase):
    def test_publication_explicit_rollback_failure_and_live_continuity(self):
        self.assertEqual(os.geteuid(), 0, 'run the opt-in drill as root for private-input validation')
        old_umask = os.umask(0o077)
        fixture = PublishedTopology('runTest'); fixture.setUp()
        root = fixture.root
        current, target, env, policy = [root / name for name in ('current.json','target.json','private.env','policy.json')]
        env.write_text('')
        command = op.compose_command(current, env)
        live = None
        try:
            for image in (OLD, NEW): op.run(['docker','image','inspect',image], timeout=30)
            for directory in ('pg','objects'): os.chmod(root / directory, 0o700)
            (root / 'pg' / 'PG_VERSION').write_text('16\n')
            fixture.enable_external_ingress()
            services = fixture.services
            project = 'kala-dashboard-test-' + os.urandom(6).hex()
            for name, service in services.items():
                service['image'] = OLD if name == 'dashboard' else NEW
                service['entrypoint'] = ['/nodejs/bin/node','--input-type=module','-e',SCRIPT]
                service['working_dir'] = '/app/packages/runtime-ingress-gateway'
                service['command'] = []
                service['environment'] = {**{key: 'fixture-only-value' for key in op.AUTHORITY_ENV.get(name, ())}, **service.get('environment', {}), 'FIXTURE_ROLE': name}
                service['healthcheck'] = {'test':['CMD','/nodejs/bin/node','-e',
                    "require('node:http').get('http://127.0.0.1:'+(process.env.FIXTURE_ROLE==='dashboard'?8080:13001)+'/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"],
                    'interval':'5s','timeout':'4s','retries':12,'start_period':'20s'}
                service.update({'read_only':True,'mem_limit':'96m','cpus':0.25,'pids_limit':64,'cap_drop':['ALL'],
                    'security_opt':['no-new-privileges:true'], 'logging':{'driver':'json-file','options':{'max-size':'1m','max-file':'1'}}})
            services['gateway']['ports'] = [{'target':13001,'host_ip':'127.0.0.1','published':'0','protocol':'tcp'}]
            # Every field except the Dashboard image is identical, including these fixture-only settings.
            document = {'name':project,'services':services,'networks':{'default':{}}}
            current.write_text(json.dumps(document))
            other = copy.deepcopy(document); other['services']['dashboard']['image'] = NEW
            target.write_text(json.dumps(other))
            policy.write_text(json.dumps({'schemaVersion':1,'reviewId':'isolated-dashboard-protocol','predecessorImages':op.image_map(document),
                'targetImages':op.image_map(other),'postgresMajor':16,'migrationMode':'none'}))
            args = argparse.Namespace(current_compose=str(current),current_env=str(env),target_compose=str(target),target_env=str(env),
                policy=str(policy),receipt=str(root/'forward.json'),start_timeout=15)
            # This fixture uses real Compose and validator, but its services are controlled Node
            # recipients, not real PG/SILO/Runtime/Owner or the production Dashboard application.
            op.verify_topology(current,env); op.verify_topology(target,env)
            op.run(command+['up','-d','--pull','never','--wait','--wait-timeout','60'],timeout=90)
            resolved = op.compose_config(current,env)
            stable = op.non_dashboard_snapshot(current,env,resolved)
            args.receipt = str(root/'pg'/'forbidden.json')
            with self.assertRaisesRegex(op.OperatorError,'outside application authority'):
                op.dashboard_apply(args)
            self.assertFalse(Path(args.receipt).exists())
            args.receipt = str(root/'forward.json')
            frozen = {path:path.read_bytes() for path in (current,target)}
            try:
                for path in frozen:
                    drift = json.loads(path.read_text())
                    drift['services']['runtime']['environment']['FIXTURE_DRIFT'] = 'not-deployed'
                    path.write_text(json.dumps(drift))
                with self.assertRaisesRegex(op.OperatorError,'deployed configuration differs'):
                    op.dashboard_preflight(args)
            finally:
                for path, content in frozen.items():path.write_bytes(content)
            port = op.run(command+['port','gateway','13001'],timeout=20).stdout.strip().rsplit(':',1)[1]
            def ui():
                with urllib.request.urlopen('http://127.0.0.1:'+port+'/ui',timeout=10) as response:return json.load(response)['generation']
            before = ui()
            live = socket.create_connection(('127.0.0.1',int(port)),timeout=30)
            live.sendall(b'GET /stream HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')
            self.assertIn(b'101 Switching',live.recv(4096))
            def ping(expected):live.sendall(b'ping\n');self.assertEqual(live.recv(4096),str(expected).encode()+b'\n')
            ping(1)
            self.assertEqual(op.dashboard_preflight(args)['changedServices'],['dashboard'])
            self.assertTrue(op.dashboard_apply(args)['nonDashboardContainersUnchanged'])
            after = ui(); self.assertNotEqual(before,after); ping(2)
            receipt = json.loads((root/'forward.json').read_text())
            self.assertEqual([item['phase'] for item in receipt['history']],['prepared','applying','completed'])
            self.assertEqual(stable,receipt['after'])
            rollback = argparse.Namespace(source_receipt=str(root/'forward.json'),receipt=str(root/'rollback.json'),start_timeout=15)
            old_env = env.read_bytes(); env.write_text('# changed frozen input\n')
            with self.assertRaisesRegex(op.OperatorError,'frozen Dashboard input changed'):op.dashboard_apply(rollback,rollback=True)
            env.write_bytes(old_env)
            op.dashboard_apply(rollback,rollback=True); self.assertEqual(ui(),before);ping(3)
            # A real unhealthy replacement retains a failed receipt. Explicit rollback
            # may restore the healthy predecessor; no other service is restarted.
            stopping = threading.Event()
            fault_applied = threading.Event()
            def fail_replacement():
                while not stopping.wait(0.1):
                    try:
                        if ui() == after:
                            with urllib.request.urlopen('http://127.0.0.1:'+port+'/fail-ui',timeout=3) as response:response.read()
                            fault_applied.set(); return
                    except urllib.error.HTTPError as error:error.close()
                    except (OSError, ValueError):pass
            fault = threading.Thread(target=fail_replacement,daemon=True);fault.start()
            args.receipt = str(root/'failed.json')
            try:
                with self.assertRaisesRegex(op.OperatorError,'no automatic rollback'):op.dashboard_apply(args)
            finally:stopping.set();fault.join(timeout=15)
            self.assertTrue(fault_applied.is_set())
            failed = json.loads((root/'failed.json').read_text());self.assertEqual(failed['phase'],'failed')
            self.assertEqual(stable,op.non_dashboard_snapshot(current,env,resolved));ping(4)
            rollback = argparse.Namespace(source_receipt=str(root/'failed.json'),receipt=str(root/'recover.json'),start_timeout=15)
            op.dashboard_apply(rollback,rollback=True);self.assertEqual(ui(),before);ping(5)
            # Recovery also works after the failed Dashboard container is absent.
            op.run(command+['rm','-sf','dashboard'],timeout=30)
            rollback.receipt = str(root/'recover-absent.json')
            op.dashboard_apply(rollback,rollback=True);self.assertEqual(ui(),before);ping(6)
            # Detect rather than hide an independent non-Dashboard restart.
            args.receipt = str(root/'continuity-fault.json')
            real_run = op.run
            def interrupted(cmd,*,timeout):
                result = real_run(cmd,timeout=timeout)
                if 'up' in cmd and '--no-deps' in cmd:real_run(command+['restart','runtime'],timeout=30)
                return result
            with mock.patch.object(op,'run',side_effect=interrupted):
                with self.assertRaisesRegex(op.OperatorError,'not verified'):op.dashboard_apply(args)
            self.assertEqual(json.loads((root/'continuity-fault.json').read_text())['phase'],'failed')
        finally:
            if live:live.close()
            try:
                if current.exists():op.run(command+['down','--remove-orphans'],timeout=90)
            finally:fixture.doCleanups();os.umask(old_umask)


if __name__ == '__main__':unittest.main()
