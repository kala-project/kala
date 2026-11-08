#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executorProtocolMajor,
  UPDATE_FEED_FILES,
  verifyExecutorUpdateFeed,
} from './executor-update-feed.mjs'

const publicKeyFile = fileURLToPath(new URL('./executor-update-public-key.pem', import.meta.url))
const publicKeySha256 = 'f4ca282cf8d3b24a7d52ab4cd11189baf8cfbba6d78847494e29910b4acb2c9f'

export function stageSignedExecutorUpdateFeed(directory, tag, revision, tagObject, publicKey, protocol) {
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.component !== 'all' || manifest.tag !== tag || manifest.source?.revision !== revision
    || manifest.source?.dirty !== false || manifest.version !== tag.slice(1)
    || UPDATE_FEED_FILES.some((name) => manifest.assets.includes(name) || existsSync(join(directory, name)))) {
    throw new Error('signed Executor feed requires a clean, unsigned, exact-revision all-component release')
  }
  const separator = tagObject.indexOf('\n\n')
  if (separator < 0 || !tagObject.slice(0, separator).startsWith(`object ${revision}\ntype commit\ntag ${tag}\n`)) {
    throw new Error('signed Executor feed tag must point to the exact release commit')
  }
  const annotation = tagObject.slice(separator + 2)
  if (annotation.length > 4096) throw new Error('offline-signed Executor update manifest exceeds the tag limit')
  const match = annotation.match(/^Kala release candidate\nExecutor-Update-Manifest-Base64: ([A-Za-z0-9+/]+={0,2})\n$/u)
  if (!match) throw new Error('tag has no exact offline-signed Executor update manifest')
  const encoded = match[1]
  const envelope = Buffer.from(encoded, 'base64')
  if (envelope.toString('base64') !== encoded) throw new Error('noncanonical Executor update manifest encoding')
  writeFileSync(join(directory, UPDATE_FEED_FILES[0]), envelope)
  writeFileSync(join(directory, UPDATE_FEED_FILES[1]), publicKey)
  manifest.assets.push(...UPDATE_FEED_FILES)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  verifyExecutorUpdateFeed(directory, protocol, { required: true })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const value = (flag) => {
    const index = process.argv.indexOf(flag)
    if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`)
    return process.argv[index + 1]
  }
  const directory = value('--directory')
  const tag = value('--tag')
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('invalid release tag')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const object = execFileSync('git', ['cat-file', '-p', `refs/tags/${tag}`], { encoding: 'utf8' })
  const publicKey = readFileSync(publicKeyFile)
  if (createHash('sha256').update(publicKey).digest('hex') !== publicKeySha256) {
    throw new Error('Executor update public key differs from the installed operator identity')
  }
  stageSignedExecutorUpdateFeed(directory, tag, revision, object, publicKey, executorProtocolMajor())
  console.log('Exact-tag offline-signed Executor update feed verified')
}
