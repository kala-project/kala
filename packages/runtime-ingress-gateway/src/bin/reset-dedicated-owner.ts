#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { runDedicatedOwnerCredentialCommand } from './dedicated-owner-credential-command.js'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDedicatedOwnerCredentialCommand('reset', process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
