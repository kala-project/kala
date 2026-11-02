#!/usr/bin/env python3
"""Native Dedicated control-plane proof; deliberately NOT Agent/Executor acceptance.

Uses the real published five-service graph, fresh authorities and private TLS.
No model request, existing login cache, production Origin or Executor is used.
All credentials/diagnostics stay in an owned private fixture until explicit cleanup.
"""
import os, json, pathlib, secrets, socket, ssl, subprocess, urllib.request, urllib.parse, http.cookiejar, shutil, uuid, re
import yaml, tempfile, argparse, hashlib, time
os.umask(0o077)
REPO=pathlib.Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tools-dir', type=pathlib.Path, required=True)
parser.add_argument('--image-record', type=pathlib.Path, required=True, help='Private/local JSON containing images and explicit code provenance')
parser.add_argument('--result', type=pathlib.Path, required=True, help='New sanitized result file; never overwritten')
parser.add_argument('--publish-only', action='store_true', help='Verify both published authentication shapes without starting services')
args=parser.parse_args(); TOOLS=args.tools_dir.resolve()
if args.result.exists(): raise SystemExit('Refuse to overwrite an existing result')
if int(next(line.split()[1] for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))) < 4*1024*1024:
 raise SystemExit('Native acceptance requires at least 4 GiB available memory')
record=json.loads(args.image_record.read_text()); images=record['images']
if set(images)!={'runtime','gateway','dashboard','postgres','silo'} or any(not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', value) for value in images.values()):
 raise SystemExit('An exact local five-image digest record is required')
for revision,paths in [(record['runtimeSource'],['packages/host','packages/shared','packages/kernel','packages/executor']), (record['dashboardSource'],['packages/dashboard'])]:
 if subprocess.run(['git','diff','--quiet',revision,'--',*paths],cwd=REPO).returncode:
  raise SystemExit('Cached application source differs from the current worktree')
if not record.get('gatewayProvenance'): raise SystemExit('Explicit Gateway provenance is required')
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='native-control-',dir=TOOLS)); print('Private fixture:',ROOT,flush=True)
REC=ROOT/'recovery';REC.mkdir(mode=0o700)
PROJECT='kala-dedicated-proof-'+uuid.uuid4().hex[:12]
(ROOT/'owned-fixture.json').write_text(json.dumps({'project':PROJECT,'syntheticCredentials':True,'nativeServices':True}))
BIN=ROOT/'bin';BIN.mkdir();(BIN/'docker').write_text('#!/bin/sh\nexec sudo -n --preserve-env=COMPOSE_PROJECT_NAME,KALA_ASPIRE_INIT_DIR,KALA_ASPIRE_SECRETS_DIR,KALA_MC_IMAGE /usr/bin/docker --host unix:///var/run/docker.sock "$@"\n');(BIN/'docker').chmod(0o700)
ENV={k:v for k,v in os.environ.items() if not k.startswith(('KALA_','OIDC_','COMPOSE_','DOCKER_','Parameters__','ASPIRE_','NUGET_','COPILOT_')) and k not in ('GH_TOKEN','GITHUB_TOKEN')}
HOME=pathlib.Path(tempfile.mkdtemp(prefix='kala-aspire-home-'))
ENV.update({'HOME':str(HOME),'DOTNET_CLI_HOME':str(HOME),'XDG_CONFIG_HOME':str(HOME/'.config'),'NUGET_PACKAGES':str(pathlib.Path.home()/'.nuget/packages'),'DOTNET_GENERATE_ASPNET_CERTIFICATE':'false'})
ENV.update({'PATH':str(BIN)+':'+str(TOOLS/'dotnet')+':'+ENV['PATH'],'DOTNET_ROOT':str(TOOLS/'dotnet'),'DOTNET_CLI_TELEMETRY_OPTOUT':'1','ASPIRE_CLI_TELEMETRY_OPTOUT':'1','COMPOSE_PROJECT_NAME':PROJECT})
def run(args,log=None,check=True,timeout=300):
 p=subprocess.run([str(x) for x in args],env=ENV,capture_output=True,text=True,timeout=timeout,cwd=REPO)
 if log:(ROOT/log).write_text(p.stdout+'\n'+p.stderr)
 if check and p.returncode:raise RuntimeError('Fixture command failed; inspect protected '+str(log or 'diagnostics'))
 return p
D=[str(BIN/'docker')]
for image in images.values(): run(D+['image','inspect',image],timeout=30)
# Only synthetic credentials and empty, owned authorities are created.
secret_dir=ROOT/'secrets';secret_dir.mkdir(mode=0o700)
for d in ['postgres','silo']:(ROOT/d).mkdir(mode=0o700)
roles={'postgres_admin_url':('postgres','postgres'),'control_owner_url':('kala_control_owner','runlab_control'),'gateway_database_url':('kala_gateway','runlab_control'),'runtime_owner_url':('kala_runtime_owner','kala_runtime'),'runtime_database_url':('kala_runtime','kala_runtime'),'runtime_reader_database_url':('kala_runtime_reader','kala_runtime')}
passwords={n:secrets.token_hex(24) for n in roles}
values={n:f'postgres://{user}:{passwords[n]}@postgres:5432/{db}' for n,(user,db) in roles.items()}
values.update(silo_root_access_key='root'+secrets.token_hex(7),silo_root_secret_key=secrets.token_hex(24),runtime_s3_access_key='runtime'+secrets.token_hex(6),runtime_s3_secret_key=secrets.token_hex(24),installation_id=str(uuid.uuid4()),owner_password=secrets.token_urlsafe(32))
key=secrets.token_bytes(32)
for name,value in values.items():(secret_dir/name).write_text(value);(secret_dir/name).chmod(0o600)
(secret_dir/'runtime_state_master_key').write_bytes(key);(secret_dir/'runtime_state_master_key').chmod(0o600)
for name,data in [('state-key',key),('installation-id',values['installation_id'].encode())]:
 p=REC/name;p.write_bytes(data);run(['sudo','-n','chown',str(os.getuid())+':65532',p]);run(['sudo','-n','chmod','440',p])
run(['sudo','-n','chown','-R','0:0',secret_dir])
def write_secret(name,data):
 if isinstance(data,str):data=data.encode()
 subprocess.run(['sudo','-n','tee',str(secret_dir/name)],input=data,stdout=subprocess.DEVNULL,check=True)
for name in ['deployment.json']:
 shutil.copyfile(REPO/'deploy/aspire'/name,REC/name);(REC/name).chmod(0o644)
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
origin=f'https://localhost:{port}'
ENV.update(KALA_PUBLIC_HOSTNAME='localhost',KALA_PUBLIC_ORIGIN=origin,KALA_PUBLIC_PORT=str(port),KALA_RUNTIME_LLM_MODEL='unconfigured-no-model-requests',KALA_RUNTIME_LLM_BASE_URL='http://127.0.0.1:9/v1',KALA_POSTGRES_DATA_DIR=str(ROOT/'postgres'),KALA_SILO_DATA_DIR=str(ROOT/'silo'),KALA_RUNTIME_STATE_MASTER_KEY_FILE=str(REC/'state-key'),KALA_INSTALLATION_ID_FILE=str(REC/'installation-id'))
with socket.socket() as s:s.bind(('127.0.0.1',0));handoff=s.getsockname()[1]
ENV.update(KALA_INGRESS_MODE='external',KALA_GATEWAY_LOOPBACK_PORT=str(handoff),KALA_DEPLOYMENT_CONFIG_FILE=str(REC/'deployment.json'))
for n in images:ENV['KALA_'+('EDGE' if n=='ingress' else n.upper())+'_IMAGE']=images[n]
OUT=REC/'published'
run([TOOLS/'aspire-cli/aspire','publish','--apphost',REPO/'deploy/aspire/Kala.Dedicated.AppHost.csproj','--output-path',OUT,'--non-interactive','--nologo'],'publish.log',timeout=300)
compose=OUT/'docker-compose.yaml';envfile=OUT/'.env';doc=yaml.safe_load(compose.read_text());svcs=doc['services']; assignments={}
# Only resource budgets are added to the published graph: entrypoints/commands,
# health checks, mounts and all native application code remain untouched.
for name,svc in svcs.items():
 svc.setdefault('deploy',{}).setdefault('resources',{})['limits']={'cpus':'1.0','memory':'1024M' if name=='runtime' else '512M'}
def assign(template,value):
 match=re.fullmatch(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[^}]*)\}',str(template))
 if match:assignments[match[1]]=str(value)
 elif str(template)!=str(value):raise RuntimeError('Unexpected literal in published binding; refuse ad hoc replacement')
config_values={('postgres','POSTGRES_PASSWORD'):passwords['postgres_admin_url'],('gateway','KALA_INGRESS_DATABASE_URL'):values['gateway_database_url'],('gateway','KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING'):values['runtime_reader_database_url'],('runtime','KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING'):values['runtime_database_url'],('silo','MINIO_ROOT_USER'):values['silo_root_access_key'],('silo','MINIO_ROOT_PASSWORD'):values['silo_root_secret_key'],('runtime','KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID'):values['runtime_s3_access_key'],('runtime','KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY'):values['runtime_s3_secret_key'],('gateway','KALA_INGRESS_SESSION_SECRET'):secrets.token_urlsafe(32),('runtime','KALA_RUNTIME_HOST_LLM_API_KEY'):'fixture-placeholder-never-used-for-model'}
ingress_secret=secrets.token_urlsafe(32)
for n in ['runtime','gateway']:config_values[(n,'KALA_INGRESS_SHARED_SECRET')]=ingress_secret
for (n,k),v in config_values.items():assign(svcs[n]['environment'][k],v)
files={'/etc/kala/deployment.json':REC/'deployment.json','/run/kala-secrets/runtime-state-master-key':REC/'state-key','/run/kala-secrets/installation-id':REC/'installation-id','/etc/caddy/Caddyfile':ROOT/'Caddyfile'}
for n,svc in svcs.items():
 for m in svc.get('volumes',[]):
  if m['type']=='bind':
   source=ROOT/('postgres' if n=='postgres' else 'silo') if n in ['postgres','silo'] else files[m['target']]
   assign(m['source'],source)
for name,volume in doc.get('volumes',{}).items():
 if volume.get('external'):raise RuntimeError('Fixture must not use external volumes')
 volume['name']=PROJECT+'-'+name
raw={}
for line in envfile.read_text().splitlines():
 match=re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$',line)
 if match:raw[match[1]]=match[2]
for k,v in assignments.items():raw[k]=json.dumps(v)
raw['COMPOSE_PROJECT_NAME']=json.dumps(PROJECT)
envfile.write_text(''.join(f'{k}={v}\n' for k,v in raw.items()));envfile.chmod(0o600)
compose.write_text(yaml.safe_dump(doc,sort_keys=False));compose.chmod(0o600)
ENV['DOCKER_HOST']='unix:///var/run/docker.sock'
ENV.update(KALA_MC_IMAGE=images['silo'],KALA_DEDICATED_ORGANIZATION_NAME='Dedicated lifecycle fixture',KALA_ASPIRE_START_TIMEOUT_SECONDS='180')
C=D+['compose','--project-directory',str(OUT),'--env-file',str(envfile),'-f',str(compose)]
rendered=json.loads(run(C+['config','--format','json']).stdout)
assert rendered['name']==PROJECT,'Refuse to start a non-fixture Compose project'
init=['sudo','-n','--preserve-env=COMPOSE_PROJECT_NAME,DOCKER_HOST,KALA_MC_IMAGE,KALA_DEDICATED_ORGANIZATION_NAME,KALA_ASPIRE_START_TIMEOUT_SECONDS','bash',REPO/'deploy/aspire/initialize.sh',compose,envfile,secret_dir]
import time, hashlib
summary={'sourceRevision':run(['git','rev-parse','HEAD']).stdout.strip(),'workingTreePaths':run(['git','diff','--name-only']).stdout.splitlines(),'project':PROJECT,'images':images,'imageProvenance':{k:v for k,v in record.items() if k!='images'},'phases':[],'kind':'native-control-only','overallAcceptance':'blocked','agentExecutorGate':'blocked-no-independent-copilot-authentication','modelRequestsInitiatedByHarness':0,'kernelProvider':'placeholder-key-and-unreachable-endpoint-infrastructure-only','resourceBudgetOverrideOnly':True}
summary['driverSha256']=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
proxy=None;TC=None
OP=['sudo','-n','--preserve-env=COMPOSE_PROJECT_NAME,DOCKER_HOST']
def rootrun(args,log=None,check=True,timeout=300):return run(OP+args,log,check,timeout)
def phase(name):
 summary['phases'].append(name);print(name,flush=True);(ROOT/'summary.json').write_text(json.dumps(summary,indent=2))
PKI=ROOT/'external-pki';PKI.mkdir(mode=0o700)
run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',PKI/'server.key','-out',PKI/'server.crt','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],'external-cert.log')
cert_hash=hashlib.sha256((PKI/'server.crt').read_bytes()).hexdigest()
proxyjs=ROOT/'external-proxy.cjs'
proxyjs.write_text('''const fs=require('fs'),https=require('https');
const{createRequire}=require('module');const r=createRequire(process.env.KALA_FIXTURE_REPO+'/packages/host/package.json');
const proxy=r('http-proxy').createProxyServer({target:'http://127.0.0.1:'+process.env.HANDOFF,ws:true,xfwd:true});
proxy.on('error',(_,req,res)=>{if(res?.writeHead)res.writeHead(502);res?.end?.();});
const s=https.createServer({key:fs.readFileSync(process.env.PKI+'/server.key'),cert:fs.readFileSync(process.env.PKI+'/server.crt')},(req,res)=>proxy.web(req,res));
s.on('upgrade',(req,socket,head)=>proxy.ws(req,socket,head));s.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('ready'));
''')
def startproxy():
 global proxy
 e=ENV|{'KALA_FIXTURE_REPO':str(REPO),'HANDOFF':str(handoff),'PKI':str(PKI),'PORT':str(port)}
 proxy=subprocess.Popen(['node',str(proxyjs)],env=e,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 assert proxy.stdout.readline().strip()=='ready'
def fence():
 global proxy
 if proxy is not None:proxy.terminate();proxy.wait(timeout=10);proxy=None
 with socket.socket() as s:assert s.connect_ex(('127.0.0.1',port))!=0

def websocket_probe():
 js=ROOT/'websocket-check.cjs'
 js.write_text("""const{createRequire}=require('module');const r=createRequire(process.env.KALA_FIXTURE_REPO+'/packages/host/package.json');
const{io}=r('socket.io-client');const s=io(process.env.ORIGIN+'/dashboard',{transports:['websocket'],reconnection:false,ca:require('fs').readFileSync(process.env.CERT),extraHeaders:{Cookie:process.env.COOKIE,Origin:process.env.ORIGIN},auth:{role:'dashboard',clientVersion:'1.1.0',clientId:'native-control-proof'}});
let ready=false,catalog;const t=setTimeout(()=>{s.close();process.exit(2)},20000);
function done(){if(!ready||!catalog)return;clearTimeout(t);console.log(JSON.stringify({authenticatedSessionListRoundTrip:true,runtimes:catalog.map(({id,available,status})=>({id,available,status}))}));s.close()}
s.on('server:agent_runtimes',p=>{catalog=p.runtimes;done()});s.on('connect',()=>s.emit('client:list_sessions',{}));s.on('server:sessions',p=>{if(!Array.isArray(p.sessions))return;ready=true;done()});s.on('connect_error',()=>{clearTimeout(t);s.close();process.exit(3)});
""")
 e=ENV|{'KALA_FIXTURE_REPO':str(REPO),'ORIGIN':origin,'CERT':str(PKI/'server.crt'),'COOKIE':'; '.join(c.name+'='+c.value for c in jar)}
 p=subprocess.run(['node',str(js)],env=e,capture_output=True,text=True,timeout=30)
 (ROOT/'websocket.log').write_text(p.stdout+'\n'+p.stderr)
 assert p.returncode==0,'Native authenticated business Socket handshake failed'
 proof=json.loads(p.stdout)
 copilot=next(runtime for runtime in proof['runtimes'] if runtime['id']=='copilot')
 assert not copilot['available'] and copilot['status']!='ready','Unexpected ambient Copilot identity'
 return proof

try:
 # A second real publish verifies the opt-in shape without deploying a fake identity.
 authout=REC/'auth-published'; ENV['KALA_COPILOT_AUTH_MODE']='github-token'
 run([TOOLS/'aspire-cli/aspire','publish','--apphost',REPO/'deploy/aspire/Kala.Dedicated.AppHost.csproj','--output-path',authout,'--non-interactive','--nologo'],'auth-publish.log',timeout=300)
 ENV.pop('KALA_COPILOT_AUTH_MODE')
 authdoc=yaml.safe_load((authout/'docker-compose.yaml').read_text())
 authenv=authdoc['services']['runtime']['environment']
 assert authenv['KALA_DEDICATED_COPILOT_AUTH_MODE']=='github-token'
 binding=authenv['COPILOT_GITHUB_TOKEN']; match=re.fullmatch(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[^}]*)\}',binding); assert match
 for name,svc in authdoc['services'].items():
  if name!='runtime': assert not any(key in svc.get('environment',{}) for key in ('COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN'))
 for name,svc in svcs.items():
  assert 'COPILOT_GITHUB_TOKEN' not in svc.get('environment',{})
 assert match[1] not in ('COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN'),'Dedicated parameter must not alias an ambient SDK token'
 for key in ('COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN'): ENV[key]='ambient-fixture-token-not-a-credential'
 for token,expected in [('',False),('fixture-placeholder-never-used-for-model',True)]:
  (authout/'.env').write_text(envfile.read_text()+match[1]+'='+json.dumps(token)+'\n')
  gate=run(['python3',REPO/'deploy/aspire/verify-published-compose.py',authout/'docker-compose.yaml',authout/'.env'],check=False)
  assert (gate.returncode==0)==expected,'Real published authentication admission mismatch'
 for key in ('COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN'): ENV.pop(key)
 summary.update(copilotParameterEnvironment=match[1],ambientSdkVariablesIgnored=True)
 phase('real_aspire_publish_default_and_runtime_only_opt_in_auth_gate')
 if args.publish_only:
  summary.update(kind='publication-only',nativeControlGate='not_run')
  raise SystemExit(0)
 run(init+['--initialize-only','--acknowledge-external-ingress-fenced'],'initialize.log',timeout=300)
 run(init+['--acknowledge-external-ingress-fenced','--resume-initialized'],'resume.log',timeout=300)
 assert set(run(C+['ps','--services','--status','running']).stdout.splitlines())==set(images)
 phase('five_native_services_initialized_claimed_and_healthy')
 startproxy()
 ctx=ssl.create_default_context(cafile=str(PKI/'server.crt'));jar=http.cookiejar.CookieJar()
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx),urllib.request.HTTPCookieProcessor(jar))
 anonymous=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))
 request=urllib.request.Request(origin+'/auth/login',data=urllib.parse.urlencode({'password':values['owner_password']}).encode(),headers={'Origin':origin,'Content-Type':'application/x-www-form-urlencoded'})
 with opener.open(request,timeout=15) as response: assert response.status==200
 with opener.open(origin+'/auth/me',timeout=15) as response: assert json.load(response)['organization']['role']=='owner'
 with opener.open(origin+'/',timeout=15) as response: assert response.status==200 and b'<html' in response.read().lower()
 summary['socketBefore']=websocket_probe()
 phase('native_ui_verified_tls_owner_identity_and_business_socket_ready')
 docs={}
 import urllib.error
 for path in ['/memo','/user/session-tabs']:
  with opener.open(origin+path,timeout=15) as response: before=json.load(response)
  content='native-'+uuid.uuid4().hex if path=='/memo' else json.dumps({'version':1,'sessions':[],'proof':uuid.uuid4().hex})
  payload=json.dumps({'content':content,'expectedRevision':before['revision']}).encode()
  request=urllib.request.Request(origin+path,method='PUT',data=payload,headers={'Origin':origin,'Content-Type':'application/json'})
  with opener.open(request,timeout=15) as response: docs[path]=json.load(response)
  assert docs[path]['content']==content and docs[path]['revision']==before['revision']+1
  try: opener.open(request,timeout=15); raise AssertionError('Stale native write unexpectedly succeeded')
  except urllib.error.HTTPError as error: assert error.code==409
  for client,headers in [(anonymous,{'Origin':origin}),(opener,{'Origin':'https://evil.example.test'})]:
   try: client.open(urllib.request.Request(origin+path,method='PUT',data=payload,headers=headers|{'Content-Type':'application/json'}),timeout=15); raise AssertionError('Untrusted write admitted')
   except urllib.error.HTTPError as error: assert error.code in (401,403)
 phase('native_user_state_writes_revision_conflicts_and_authority_rejection')
 before_ids={name:run(C+['ps','--quiet',name]).stdout.strip() for name in images}
 cookie_before=hashlib.sha256(';'.join(c.name+'='+c.value for c in jar).encode()).hexdigest()
 run(C+['up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','180','runtime','gateway','dashboard'],'native-recreate.log',timeout=300)
 after_ids={name:run(C+['ps','--quiet',name]).stdout.strip() for name in images}
 assert all(before_ids[name]!=after_ids[name] for name in ['runtime','gateway','dashboard'])
 assert all(before_ids[name]==after_ids[name] for name in ['postgres','silo'])
 with opener.open(origin+'/auth/me',timeout=15) as response: assert json.load(response)['organization']['role']=='owner'
 assert hashlib.sha256(';'.join(c.name+'='+c.value for c in jar).encode()).hexdigest()==cookie_before
 for path,document in docs.items():
  with opener.open(origin+path,timeout=15) as response: assert json.load(response)==document
 summary['socketAfter']=websocket_probe()
 phase('native_app_containers_recreated_owner_cookie_and_pg_state_persisted')
 summary.update(nativeControlGate='passed',cookieSha256=cookie_before,externalCertificateSha256=cert_hash,documents={path:{'revision':doc['revision'],'contentSha256':hashlib.sha256(doc['content'].encode()).hexdigest()} for path,doc in docs.items()})
except Exception as error:
 summary.update(nativeControlGate='failed',error=type(error).__name__)
 raise
finally:
 fence()
 run(C+['logs','--tail','30','gateway','runtime'],'native-diagnostics.log',check=False)
 cleanup=run(C+['down','--timeout','15'],'cleanup.log',check=False,timeout=120)
 remaining=run(D+['ps','--all','--quiet','--filter','label=com.docker.compose.project='+PROJECT],check=False)
 summary['cleanupContainersConfirmed']=cleanup.returncode==0 and remaining.returncode==0 and not remaining.stdout.strip()
 (ROOT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 args.result.parent.mkdir(parents=True,exist_ok=True)
 with args.result.open('x') as output: output.write(json.dumps(summary,indent=2)+'\n')
 shutil.rmtree(HOME)
 print('Sanitized result:',args.result,flush=True)
