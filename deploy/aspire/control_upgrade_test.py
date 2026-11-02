"""Opt-in real PG/S3/Owner/migration/cold-recovery drill; app nodes are protocol fixtures.

No model, Agent, real Runtime/Gateway HTTP or remote Executor acceptance is claimed.
Requires a locally prepared current Gateway candidate via KALA_SCHEMA_CANDIDATE_IMAGE.
"""
import argparse
import copy
import json
import os
import subprocess
from pathlib import Path
import unittest
import uuid
from unittest import mock

import lifecycle_operator as op
from test_verify_published_compose import PublishedTopology

GATEWAY = 'kala-dedicated-parented-gateway@sha256:53b3352e4f673365cb6615a4171ec829a8c2759090af37a8e25bf4d7aade3ec5'
RUNTIME = 'kala-dedicated-parented-runtime@sha256:f608d94689aeb5a97e0803ef0f9976569d954835f383144af31f699ec3d6f3dd'
POSTGRES = 'postgres@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36'
SILO = 'pgsty/silo@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7'
SCRIPT = r"""
import http from 'node:http';import fs from 'node:fs';import pg from 'pg';
const role=process.env.FIXTURE_ROLE;
const expected=role==='gateway'?fs.readdirSync('migrations').filter(x=>/^\d{4}_.*\.sql$/.test(x)).length:0;
const server=http.createServer(async(req,res)=>{
 if(role==='gateway') {const client=new pg.Client({connectionString:process.env.KALA_INGRESS_DATABASE_URL});try{
  await client.connect();const result=await client.query('SELECT MAX(version)::integer AS v FROM control_plane_schema_migrations');
  if(result.rows[0].v!==expected)res.statusCode=503;
 }catch{res.statusCode=503;}finally{await client.end().catch(()=>{});}}
 res.end(JSON.stringify({role,expected}));
});
server.listen(role==='dashboard'?8080:13001,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
"""


@unittest.skipUnless(os.environ.get('KALA_RUN_CONTROL_UPGRADE_DOCKER') == '1', 'explicit isolated PG/S3 gate')
class ControlUpgradeDockerTests(unittest.TestCase):
    def test_control_upgrade_atomicity_unknown_commit_target_failure_and_fresh_restore(self):
        self.assertEqual(os.geteuid(), 0)
        candidate = os.environ['KALA_SCHEMA_CANDIDATE_IMAGE']
        self.assertTrue(op.IMAGE.fullmatch(candidate))
        old_umask = os.umask(0o077)
        fixture = PublishedTopology('runTest');fixture.setUp()
        root = fixture.root
        projects = []
        receipts = root/'receipts';receipts.mkdir(mode=0o700)
        artifacts = root/'artifacts';artifacts.mkdir(mode=0o700)
        recovery = root/'recovery';recovery.mkdir(mode=0o700)
        secrets = recovery/'init-secrets';secrets.mkdir(mode=0o700)
        try:
            for image in (candidate,GATEWAY,RUNTIME,POSTGRES,SILO):op.run(['docker','image','inspect',image],timeout=30)
            installation = str(uuid.uuid4());key = os.urandom(32)
            for name in ('deployment.json','key','installation-id'):
                (root/name).rename(recovery/name)
            (recovery/'key').write_bytes(key);(recovery/'installation-id').write_text(installation+'\n')
            (recovery/'deployment.json').chmod(0o444)
            for path in (recovery/'key',recovery/'installation-id'):os.chown(path,65532,65532);path.chmod(0o400)
            values = {'installation_id':installation,'runtime_state_master_key':key,'owner_password':uuid.uuid4().hex,
                'silo_root_access_key':'root'+uuid.uuid4().hex[:12], 'silo_root_secret_key':uuid.uuid4().hex,
                'runtime_s3_access_key':'runtime'+uuid.uuid4().hex[:12], 'runtime_s3_secret_key':uuid.uuid4().hex}
            for name,user,db in [('postgres_admin_url','postgres','postgres'),('control_owner_url','kala_control_owner','runlab_control'),
                ('gateway_database_url','kala_gateway','runlab_control'),('runtime_owner_url','kala_runtime_owner','kala_runtime'),
                ('runtime_database_url','kala_runtime','kala_runtime'),('runtime_reader_database_url','kala_runtime_reader','kala_runtime')]:
                values[name] = f'postgresql://{user}:{uuid.uuid4().hex}@postgres:5432/{db}'
            for name,value in values.items():(secrets/name).write_bytes(value if isinstance(value,bytes) else value.encode())
            fixture.enable_external_ingress()
            services = fixture.services
            for service in services.values():
                for mount in service.get('volumes',[]):
                    if Path(mount['source']).parent == root and Path(mount['source']).name in ('deployment.json','key','installation-id'):
                        mount['source'] = str(recovery/Path(mount['source']).name)
                service['networks'] = ['aspire']
                service['logging'] = {'driver':'json-file','options':{'max-size':'1m','max-file':'1'}}
                service['pids_limit'] = 96;service['cpus'] = 0.5
            services['postgres']['image'] = POSTGRES
            services['postgres']['mem_limit'] = '256m'
            services['postgres']['environment'] = {'POSTGRES_PASSWORD':values['postgres_admin_url'].split(':')[2].split('@')[0],'POSTGRES_USER':'postgres','POSTGRES_DB':'postgres'}
            services['postgres']['healthcheck']['test'] = ['CMD','pg_isready','-U','postgres','-d','postgres']
            services['silo'].update(image=SILO,command=['server','/data','--console-address',':9001'],mem_limit='384m',
                environment={'MINIO_ROOT_USER':values['silo_root_access_key'],'MINIO_ROOT_PASSWORD':values['silo_root_secret_key'],'GOMEMLIMIT':'192MiB'})
            services['silo']['healthcheck']['test'] = ['CMD','curl','-fsS','--max-time','3','http://127.0.0.1:9000/minio/health/ready']
            for name in ('gateway','runtime','dashboard'):
                service = services[name];service['image'] = RUNTIME if name=='runtime' else GATEWAY
                service['entrypoint'] = ['/nodejs/bin/node','--input-type=module','-e',SCRIPT]
                service['working_dir'] = '/app/packages/host' if name=='runtime' else '/app/packages/runtime-ingress-gateway'
                service['command'] = [];service['mem_limit'] = '128m';service['read_only'] = True
                service['environment'] = {**{k:'fixture-only-value' for k in op.AUTHORITY_ENV.get(name,())},
                    **service.get('environment',{}),'FIXTURE_ROLE':name,'KALA_DEPLOYMENT_CONFIG':'/etc/kala/deployment.json',
                    'KALA_INSTALLATION_ID_FILE':'/run/kala-secrets/installation-id'}
                service['healthcheck']['test'] = ['CMD','/nodejs/bin/node','-e',
                    "require('node:http').get('http://127.0.0.1:'+(process.env.FIXTURE_ROLE==='dashboard'?8080:13001)+'/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]
            services['runtime']['environment'].update(KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING=values['runtime_database_url'],
                KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID=values['runtime_s3_access_key'],KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY=values['runtime_s3_secret_key'],
                KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET='kala-runtime',KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT='http://silo:9000',
                KALA_RUNTIME_EXPERIMENTAL_S3_REGION='us-east-1',KALA_RUNTIME_EXPERIMENTAL_S3_FORCE_PATH_STYLE='true',
                KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE='/run/kala-secrets/runtime-state-master-key')
            services['gateway']['environment'].update(KALA_INGRESS_DATABASE_URL=values['gateway_database_url'],
                KALA_INGRESS_MIGRATIONS_DIR='/app/packages/runtime-ingress-gateway/migrations',
                KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING=values['runtime_reader_database_url'])
            services['gateway']['ports'][0]['published'] = '0'
            original = {'name':'kala-schema-test-'+uuid.uuid4().hex[:10],'services':services,'networks':{'aspire':{}}}
            env = recovery/'private.env';env.write_text('')
            init = copy.deepcopy(original)
            for name in ('gateway','runtime'):
                init['services'][name]['entrypoint'] = ['/nodejs/bin/node']
                init['services'][name]['working_dir'] = '/app'
            init_file = recovery/'initialize.json';init_file.write_text(json.dumps(init))
            projects.append((init_file,env))
            with mock.patch.dict(os.environ, {'KALA_MC_IMAGE':SILO,'KALA_DEDICATED_ORGANIZATION_NAME':'Schema acceptance','KALA_ASPIRE_START_TIMEOUT_SECONDS':'120'}):
                initialized = subprocess.run(['bash',str(Path(__file__).with_name('initialize.sh')),str(init_file),str(env),str(secrets),
                    '--initialize-only','--acknowledge-external-ingress-fenced'],timeout=300,capture_output=True,text=True)
                if initialized.returncode:
                    diagnostic = '\n'.join((initialized.stdout+'\n'+initialized.stderr).splitlines()[-18:])
                    for value in values.values():
                        if isinstance(value,str):diagnostic=diagnostic.replace(value,'[fixture-value-redacted]')
                    self.fail('isolated initialization failed: '+diagnostic)

            def pair(document, material, label):
                source=material/'active.json';source.write_text(json.dumps(document))
                target=material/'upgrade.json';other=copy.deepcopy(document);other['services']['gateway']['image']=candidate;target.write_text(json.dumps(other))
                bundle=json.loads(op.run(['docker','run','--rm']+op.control_job_arguments(candidate,'none')+['--describe'],timeout=30).stdout)
                policy=material/'schema-policy.json';policy.write_text(json.dumps({'schemaVersion':2,'reviewId':'schema-drill-'+label,
                    'predecessorImages':op.image_map(document),'targetImages':op.image_map(other),'postgresMajor':16,'migrationMode':'control-plane-7-to-9',
                    'controlSchema':{'fromVersion':7,'toVersion':9,'writerRole':'kala_gateway','migrations':bundle['migrations']}}))
                args=argparse.Namespace(current_compose=str(source),current_env=str(material/'private.env'),target_compose=str(target),target_env=str(material/'private.env'),
                    policy=str(policy),control_owner_url=str(material/'init-secrets'/'control_owner_url'),recovery_root=str(material),
                    installation_id_relative='installation-id',state_key_relative='key',artifact=str(artifacts/label),receipt=str(receipts/(label+'.json')),
                    stop_timeout=20,start_timeout=90,acknowledge_maintenance_and_unknown_effects=True,acknowledge_external_control_writers_fenced=True,
                    acknowledge_external_ingress_fenced=True)
                projects.append((source,material/'private.env'))
                op.run(op.compose_command(source,material/'private.env')+['up','-d','--pull','never','--wait','--wait-timeout','90'],timeout=120)
                return args

            def sql(args,text):
                ids=op.container_ids(Path(args.current_compose),Path(args.current_env),('postgres',))
                return op.run(['docker','exec',ids['postgres'],'psql','-U','postgres','-d','runlab_control','-At','-v','ON_ERROR_STOP=1','-c',text],timeout=30).stdout.strip()

            def s3(args,setup=False):
                ids=op.container_ids(Path(args.current_compose),Path(args.current_env),('silo',))
                script='mc alias set proof http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; '
                if setup:script+="mc mb --ignore-existing proof/kala-acceptance >/dev/null;mc version enable proof/kala-acceptance >/dev/null;printf version-one | mc pipe proof/kala-acceptance/object >/dev/null;printf version-two | mc pipe proof/kala-acceptance/object >/dev/null;"
                script+='mc cat proof/kala-acceptance/object; mc ls --versions --json proof/kala-acceptance/object'
                return op.run(['docker','exec',ids['silo'],'/bin/sh','-ec',script],timeout=30).stdout

            def owner(args,image):
                material=Path(args.recovery_root)/'init-secrets';config=op.compose_config(Path(args.current_compose),Path(args.current_env))
                ids=op.container_ids(Path(args.current_compose),Path(args.current_env),('postgres',))
                networks=json.loads(op.run(['docker','inspect','--format','{{json .NetworkSettings.Networks}}',ids['postgres']],timeout=30).stdout)
                cmd=['docker','run','--rm','--pull=never','--network',next(iter(networks)),'--memory','128m','--user','0:0',
                    '--mount',f'type=bind,src={material/"control_owner_url"},dst=/run/owner-url,readonly',
                    '--mount',f'type=bind,src={material/"owner_password"},dst=/run/owner-password,readonly',
                    '--mount',f'type=bind,src={Path(args.recovery_root)/"deployment.json"},dst=/run/deployment.json,readonly',
                    '-e','KALA_DEPLOYMENT_CONFIG=/run/deployment.json','-e','KALA_INGRESS_EXPERIMENTAL_DOCKER_STORAGE=1',
                    '-e','KALA_INGRESS_DATABASE_URL_FILE=/run/owner-url','-e','KALA_DEDICATED_OWNER_PASSWORD_FILE=/run/owner-password',
                    '-e','KALA_DEDICATED_ORGANIZATION_NAME=Schema acceptance','-e','KALA_INGRESS_MIGRATIONS_DIR=/app/packages/runtime-ingress-gateway/migrations','--entrypoint','/nodejs/bin/node',image,
                    '/app/packages/runtime-ingress-gateway/dist/src/bin/bootstrap-dedicated-owner.js','--verify-existing']
                op.run(cmd,timeout=30)

            args=pair(original,recovery,'success')
            self.assertEqual(sql(args,'SELECT MAX(version) FROM control_plane_schema_migrations'),'7')
            sql(args,"INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload) VALUES('legacy','old','system','system','{}')")
            object_versions=s3(args,True);owner(args,GATEWAY)
            self.assertEqual(op.control_upgrade_preflight(args)['event'],'control_upgrade_preflight_accepted')
            _,_,_,paths,network=op.control_upgrade_pair(args)
            op.run(op.compose_command(Path(args.current_compose),Path(args.current_env))+['stop','-t','20','gateway','runtime','dashboard'],timeout=50)
            sql(args,'GRANT kala_control_owner TO kala_gateway')
            with self.assertRaises(op.OperatorError):
                op.run(['docker','run','--rm']+op.control_job_arguments(candidate,network,paths)+['--apply'],timeout=90)
            self.assertEqual(sql(args,"SELECT MAX(version),to_regclass('webhook_deliveries') IS NULL FROM control_plane_schema_migrations"),'7|t')
            self.assertEqual(sql(args,"SELECT has_table_privilege('kala_gateway','control_plane_schema_migrations','UPDATE')"),'t')
            sql(args,'REVOKE kala_control_owner FROM kala_gateway')
            op.run(op.compose_command(Path(args.current_compose),Path(args.current_env))+['up','-d','--wait','--wait-timeout','90'],timeout=120)
            with op.host_lock(root/'test-lifecycle.lock'):op.control_upgrade(args)
            self.assertEqual(sql(args,'SELECT MAX(version) FROM control_plane_schema_migrations'),'9')
            self.assertEqual(sql(args,"SELECT webhook_fanout_state FROM outbox_events WHERE id='legacy'"),'legacy_review')
            self.assertEqual(sql(args,"SELECT has_table_privilege('kala_gateway','control_plane_schema_migrations','UPDATE')"),'f')
            owner(args,candidate);self.assertEqual(s3(args),object_versions)
            self.assertEqual(json.loads(Path(args.receipt).read_text())['phase'],'completed')

            def restore(source,label):
                op.cold_stop(Path(source.current_compose),Path(source.current_env),20,set(original['services']))
                parent=root/label;parent.mkdir(mode=0o700)
                for name in ('pg','objects','recovery'):(parent/name).mkdir(mode=0o700)
                restored=copy.deepcopy(original);restored['name']=original['name']+'-'+label
                for service in restored['services'].values():
                    for mount in service.get('volumes',[]):
                        old=Path(mount['source'])
                        if old==root/'pg':mount['source']=str(parent/'pg')
                        elif old==root/'objects':mount['source']=str(parent/'objects')
                        elif recovery in old.parents:mount['source']=str(parent/'recovery'/old.relative_to(recovery))
                config=parent/'restore.json';config.write_text(json.dumps(restored));params=parent/'restore.env';params.write_text('')
                compatibility=parent/'restore-policy.json';compatibility.write_text(json.dumps({'schemaVersion':1,'reviewId':'fresh-old-seven',
                    'predecessorImages':op.image_map(original),'targetImages':op.image_map(restored),'postgresMajor':16,'migrationMode':'none'}))
                recover_args=argparse.Namespace(source_receipt=source.receipt,receipt=str(receipts/(label+'-recovery.json')),
                    target_compose=str(config),target_env=str(params),policy=str(compatibility),postgres_destination=str(parent/'pg'),silo_destination=str(parent/'objects'),
                    recovery_destination=str(parent/'recovery'),acknowledge_source_fenced=True,acknowledge_external_ingress_fenced=True,
                    create_fresh_caddy_volumes=False,acknowledge_ingress_identity_reissue=False)
                if label=='lost-commit':
                    source_operation=json.loads(Path(source.receipt).read_text())['operationId']
                    busy='kala-control-upgrade-'+source_operation
                    op.run(['docker','run','-d','--pull=never','--network=none','--memory=64m','--cpus=0.1','--name',busy,
                        '--label','kala.control-upgrade='+source_operation,'--entrypoint','/nodejs/bin/node',candidate,'-e','setInterval(()=>{},1000)'],timeout=30)
                    try:
                        with self.assertRaisesRegex(op.OperatorError,'Compose fence alone'):op.control_upgrade_recover(recover_args)
                    finally:op.run(['docker','rm','-f',busy],timeout=30)
                    original_config=config.read_bytes();unsafe=copy.deepcopy(restored)
                    source_networks=op.compose_config(Path(source.current_compose),Path(source.current_env))['networks']
                    unsafe['networks']['aspire']['name']=source_networks['aspire']['name'];config.write_text(json.dumps(unsafe))
                    with self.assertRaisesRegex(op.OperatorError,'isolated managed networks'):op.control_upgrade_recover(recover_args)
                    config.write_bytes(original_config)
                    original_policy=compatibility.read_bytes();unsafe_policy=json.loads(original_policy)
                    unsafe_policy['targetImages']['gateway']=candidate;compatibility.write_text(json.dumps(unsafe_policy))
                    with self.assertRaisesRegex(op.OperatorError,'exact original predecessor'):op.control_upgrade_recover(recover_args)
                    compatibility.write_bytes(original_policy)
                    self.assertTrue(all(not list((parent/name).iterdir()) for name in ('pg','objects','recovery')))
                    self.assertFalse(Path(recover_args.receipt).exists())
                op.control_upgrade_recover(recover_args)
                next_args=pair(restored,parent/'recovery',label)
                self.assertEqual(sql(next_args,'SELECT MAX(version) FROM control_plane_schema_migrations'),'7')
                self.assertEqual(s3(next_args),object_versions);owner(next_args,GATEWAY)
                return next_args

            for mode in ('lost-commit','startup-failure'):
                args=restore(args,mode)
                _, case_target, case_policy, case_paths, case_network = op.control_upgrade_pair(args)
                real_run=op.run
                def fault(cmd,*,timeout):
                    result=real_run(cmd,timeout=timeout)
                    if mode=='lost-commit' and cmd[:3]==['docker','start','--attach'] and cmd[-1].startswith('kala-control-upgrade-'):
                        raise op.OperatorError('injected loss after actual commit')
                    if mode=='startup-failure' and cmd[:2]==['docker','compose'] and 'up' in cmd and '--no-deps' not in cmd:
                        raise op.OperatorError('injected target readiness failure after actual startup')
                    return result
                with mock.patch.object(op,'run',side_effect=fault):
                    with self.assertRaisesRegex(op.OperatorError,'no automatic retry'):op.control_upgrade(args)
                receipt=json.loads(Path(args.receipt).read_text())
                self.assertEqual(receipt['phase'],'failed')
                self.assertEqual(receipt['migrationResult'],'unknown' if mode=='lost-commit' else 'committed')
                self.assertEqual(sql(args,'SELECT MAX(version) FROM control_plane_schema_migrations'),'9')
                op.assert_inactive(Path(args.current_compose),Path(args.current_env),{'gateway','runtime','dashboard'})
                if mode=='lost-commit':
                    job=receipt['migrationContainer'];self.assertEqual(receipt['migrationContainerState']['exit'],0)
                    with self.assertRaises(op.OperatorError):op.control_bundle_probe(case_target,case_policy,case_paths,case_network)
                    op.run(['docker','rm',job],timeout=30)
            restore(args,'final-restored')
        finally:
            try:
                for compose,env in reversed(projects):
                    if compose.exists():op.run(op.compose_command(compose,env)+['down','--remove-orphans'],timeout=90)
                # Any retained one-off belongs only to a receipt produced inside this fixture.
                for path in receipts.glob('*.json'):
                    job=json.loads(path.read_text()).get('migrationContainer')
                    if job:
                        result=op.run(['docker','ps','-aq','--filter','name=^/'+job+'$'],timeout=30)
                        if result.stdout.strip():op.run(['docker','rm','-f',job],timeout=30)
            finally:fixture.doCleanups();os.umask(old_umask)


if __name__ == '__main__':unittest.main()
