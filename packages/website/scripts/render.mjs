import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deployPage,
  downloadPage,
  homePage,
  releasesPage,
  renderPage,
  securityPage,
} from './site-content.mjs'
import { resolveReleaseCatalog, resolveReleaseChanges } from './release-catalog.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '../..')
const outputRoot = resolve(packageRoot, '.generated')
const productAssets = resolve(packageRoot, 'public/assets/product')
const illustrationAssets = resolve(packageRoot, 'public/assets/illustration')
const origin = process.env.KALA_SITE_ORIGIN
const base = process.env.KALA_SITE_BASE ?? '/'

const releaseNotes = JSON.parse(await readFile(resolve(repositoryRoot, 'scripts/release/release-notes.json'), 'utf8'))
const fallbackCatalog = JSON.parse(await readFile(resolve(repositoryRoot, 'scripts/release/release-catalog.json'), 'utf8'))
const catalog = await resolveReleaseCatalog({ fallbackCatalog, releaseNotes })
const priorRelease = catalog.releases.find((release) => release.tag === catalog.current.previousTag)
const changeLog = Object.fromEntries(await Promise.all(
  [catalog.current, priorRelease].filter(Boolean).map(async (release) => {
    try {
      return [release.tag, await resolveReleaseChanges(release)]
    } catch (error) {
      console.warn(`Unable to load ${release.tag} commit history; linking to GitHub comparison instead: ${error.message}`)
      return [release.tag, undefined]
    }
  }),
))
const version = catalog.current.version
const stableVersion = catalog.stable?.version ?? version

const pages = [
  {
    path: 'index.html',
    page: 'home',
    title: 'Kala',
    description: 'Run durable agent sessions across models, workspaces, machines, and deployment boundaries without hiding the work.',
    content: homePage(version),
  },
  {
    path: 'download/index.html',
    page: 'download',
    title: `Download Kala ${stableVersion}`,
    description: `Install the verified Kala ${stableVersion} Portable release for supported Linux and macOS platforms.`,
    content: downloadPage(catalog),
  },
  {
    path: 'deploy/index.html',
    page: 'deploy',
    title: 'Deploy Kala',
    description: 'Compare Kala Portable, Dedicated, and Private Cloud deployment boundaries and current support status.',
    content: deployPage(version),
  },
  {
    path: 'security/index.html',
    page: 'security',
    title: 'Kala security',
    description: 'Understand Kala workspace execution, credential, durable-state, privacy, and supply-chain boundaries.',
    content: securityPage(),
  },
  {
    path: 'releases/index.html',
    page: 'releases',
    title: `Kala ${version} release`,
    description: `Read the improvements, fixes, support boundaries, and public evidence for Kala ${version}.`,
    content: releasesPage(catalog, changeLog),
  },
]

await rm(outputRoot, { recursive: true, force: true })
await mkdir(resolve(outputRoot, 'src'), { recursive: true })
await mkdir(resolve(outputRoot, 'public/assets/brand'), { recursive: true })
await mkdir(resolve(outputRoot, 'public/assets/product'), { recursive: true })
await mkdir(resolve(outputRoot, 'public/assets/illustration'), { recursive: true })

await cp(resolve(packageRoot, 'src/main.ts'), resolve(outputRoot, 'src/main.ts'))
await cp(resolve(packageRoot, 'src/styles.css'), resolve(outputRoot, 'src/styles.css'))
await cp(resolve(repositoryRoot, 'deploy/private-cloud/branding/logo-light.svg'), resolve(outputRoot, 'public/assets/brand/kala-wordmark.svg'))
await cp(resolve(repositoryRoot, 'deploy/private-cloud/branding/logo-dark.svg'), resolve(outputRoot, 'public/assets/brand/kala-wordmark-dark.svg'))
await cp(resolve(repositoryRoot, 'deploy/private-cloud/branding/icon.svg'), resolve(outputRoot, 'public/assets/brand/kala-icon.svg'))
await cp(productAssets, resolve(outputRoot, 'public/assets/product'), { recursive: true, force: true })
await cp(illustrationAssets, resolve(outputRoot, 'public/assets/illustration'), { recursive: true, force: true })

for (const page of pages) {
  const output = resolve(outputRoot, page.path)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, renderPage({ ...page, version, origin, base }), 'utf8')
}
