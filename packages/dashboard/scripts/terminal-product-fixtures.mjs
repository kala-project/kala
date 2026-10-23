export const WINDOWS_TERMINAL_NODE = 'C:\\KalaTest\\node\\node-v22.22.1-win-x64\\node.exe'

export const WINDOWS_TERMINAL_WORKER = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const [operation, name, marker, ...values] = process.argv.slice(2);
if (operation === 'tty') {
  const result = {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    cwd: process.cwd(),
    platform: process.platform,
    node: process.version,
    release: os.release()
  };
  fs.writeFileSync(path.join(__dirname, 'pty.json'), JSON.stringify(result));
  console.log('PTY_' + 'READY');
} else if (operation === 'text') {
  if (!['multiline.txt', 'virtual.txt', 'ime.txt'].includes(name)) throw new Error('Unexpected proof file');
  fs.writeFileSync(path.join(__dirname, name), values.join('\\n') + '\\n', 'utf8');
  console.log(marker + '_DONE');
} else if (operation === 'raw') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A real ConPTY is required');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  console.log('RAW_' + 'READY');
  process.stdin.once('data', (bytes) => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    fs.writeFileSync(path.join(__dirname, 'escape.bin'), bytes);
    console.log('RAW_' + bytes[0]);
  });
} else {
  throw new Error('Unknown terminal proof operation');
}
`

export function windowsTerminalFixtures({ artifact, nodeExecutable = WINDOWS_TERMINAL_NODE }) {
  if (!/^terminal-acceptance-[a-zA-Z0-9-]+$/u.test(artifact)) throw new Error('Expected a uniquely named terminal acceptance directory')
  if (!/^[A-Za-z]:\\/u.test(nodeExecutable)) throw new Error('Expected an absolute Windows Node executable path')
  const quote = (value) => `'${value.replaceAll("'", "''")}'`
  const prefix = `& ${quote(nodeExecutable)} ${quote(`.\\${artifact}\\probe.cjs`)}`
  return {
    prepareArgv: [nodeExecutable, '-e', `const fs=require('node:fs');const path=require('node:path');fs.mkdirSync(${JSON.stringify(artifact)},{recursive:true});fs.writeFileSync(path.join(${JSON.stringify(artifact)},'probe.cjs'),${JSON.stringify(WINDOWS_TERMINAL_WORKER)});`],
    ready: "Write-Output ('SHELL_' + 'READY')",
    tty: `[IO.File]::WriteAllText(${quote(`.\\${artifact}\\powershell.txt`)},$PSVersionTable.PSVersion.ToString()); ${prefix} tty`,
    multilineFirst: `${prefix} text multiline.txt MULTI @('line-one',`,
    multilineLast: "'line-two')",
    virtual: `${prefix} text virtual.txt VIRTUAL 'virtual-newline'`,
    imeFirst: `${prefix} text ime.txt IME '`,
    imeLast: "'",
    raw: `${prefix} raw`,
  }
}
