#!/usr/bin/env node
import { resolve } from 'node:path'
import { executorProtocolMajor, signExecutorUpdateFeed } from './executor-update-feed.mjs'

const value = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}
const directory = resolve(value('--directory'))
const privateKeyFile = resolve(value('--private-key-file'))
signExecutorUpdateFeed(directory, privateKeyFile, executorProtocolMajor(), { localDedicated: process.argv.includes('--local-dedicated') })
console.log('Executor update feed signed')
