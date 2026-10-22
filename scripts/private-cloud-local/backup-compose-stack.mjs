#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { composeArgs, composeFiles, root, selectedProfile } from './profile.mjs'
const profile = selectedProfile()
if (profile === 'postgres-s3') throw new Error('PG/S3 Runtime authority is not captured by the local-volume backup; use a coordinated PostgreSQL + S3 backup with a tested restore')
const backupRoot = resolve(process.env.KALA_BACKUP_DIR ?? resolve(root, 'deploy/private-cloud/backups'))
if (backupRoot === '/tmp' || backupRoot.startsWith('/tmp/')) throw new Error('KALA_BACKUP_DIR must be persistent; /tmp is forbidden')
const out = resolve(process.argv[2] ?? `${backupRoot}/${new Date().toISOString().replace(/[:.]/gu, '-')}`)
await mkdir(out, { recursive: true, mode: 0o700 })
async function run(command, args, file) {
  const handle = file ? await open(resolve(out, file), 'w', 0o600) : undefined
  try { await new Promise((ok, fail) => { const child=spawn(command,args,{cwd:root,env:process.env,stdio:['ignore',handle?.fd??'inherit','inherit']});child.on('error',fail);child.on('exit',(code)=>code===0?ok():fail(new Error(`${command} exited ${code}`))) }) }
  finally { await handle?.close() }
}
const project = process.env.COMPOSE_PROJECT_NAME ?? composeProjectName(profile)
const volumes = { tenantData:volumeName('tenant-data'), controlData:volumeName('control-data') }
const runningServices = capture('docker', ['compose', ...composeArgs(profile), 'ps', '--status', 'running', '--services']).split(/\r?\n/u).filter(Boolean)
const writers = ['runtime-ingress', 'runtime-host'].filter((service) => runningServices.includes(service))
try {
  if (writers.length > 0) runCompose(['stop', ...writers])
  await run('docker', ['compose', ...composeArgs(profile), 'exec', '-T', 'control-postgres', 'pg_dump', '-U', 'runlab', '-d', 'runlab_control', '--format=custom', '--no-owner', '--no-acl'], 'control-plane.pgdump')
  for (const [volume, file] of [[volumes.tenantData, 'tenant-data.tar'], [volumes.controlData, 'control-data.tar']]) await run('docker', ['run','--rm','--network','none','-v',`${volume}:/source:ro`,'alpine:3.22.2','tar','-C','/source','-cf','-','.'], file)
  const manifest = { schemaVersion:1, createdAt:new Date().toISOString(), profile, gitSha:capture('git',['rev-parse','HEAD']).trim(), files:{}, volumes, composeFiles:composeFiles(profile).map((p)=>p.slice(root.length+1)), encryption:{ requiredForOffHost:true, applied:false } }
  for (const name of ['control-plane.pgdump','tenant-data.tar','control-data.tar']) { const path=resolve(out,name); manifest.files[name]={ bytes:(await stat(path)).size, sha256:await hash(path) } }
  await writeFile(resolve(out,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600})
  console.log(`Backup written to ${out}`)
} finally {
  if (writers.length > 0) runCompose(['up', '-d', '--wait', ...writers])
}
async function hash(path){const h=createHash('sha256');await new Promise((ok,fail)=>createReadStream(path).on('data',(c)=>h.update(c)).on('end',ok).on('error',fail));return h.digest('hex')}
function capture(command,args){const x=spawnSync(command,args,{cwd:root,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr);return x.stdout}
function runCompose(args) {
  const x = spawnSync('docker', ['compose', ...composeArgs(profile), ...args], { cwd: root, env: process.env, stdio: 'inherit' })
  if (x.error) throw x.error
  if (x.status !== 0) throw new Error(`docker compose exited ${String(x.status)}`)
}
function composeProjectName(selected){
  const x=spawnSync('docker',['compose',...composeArgs(selected),'config','--format','json'],{cwd:root,encoding:'utf8',env:process.env})
  if(x.status!==0)throw new Error(x.stderr||'failed to resolve Compose project')
  const config=JSON.parse(x.stdout)
  if(typeof config.name!=='string'||!config.name)throw new Error('Compose project name is missing')
  return config.name
}
function volumeName(logical){
  const x=spawnSync('docker',['compose',...composeArgs(profile),'config','--volumes'],{cwd:root,encoding:'utf8',env:process.env})
  if(x.status!==0)throw new Error(x.stderr||'failed to resolve Compose volumes')
  if(!x.stdout.split(/\r?\n/u).includes(logical))throw new Error(`Compose volume is missing: ${logical}`)
  return `${project}_${logical}`
}
