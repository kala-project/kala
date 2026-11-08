import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import { deployPage, downloadPage, homePage, releasesPage, renderPage, securityPage } from './site-content.mjs'
import { normalizeReleases, normalizeTag, resolveReleaseCatalog } from './release-catalog.mjs'

const root = resolve(import.meta.dirname, '../../..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const notes = JSON.parse(await readFile(resolve(root, 'scripts/release/release-notes.json'), 'utf8'))
const fallbackCatalog = JSON.parse(await readFile(resolve(root, 'scripts/release/release-catalog.json'), 'utf8'))
const version = manifest.version
const releases = normalizeReleases(fallbackCatalog, notes)
const catalog = {
  releases,
  current: releases.find((release) => release.version === version) ?? releases.find((release) => !release.prerelease) ?? releases[0],
  stable: releases.find((release) => !release.prerelease),
  preview: releases.find((release) => release.prerelease),
  source: 'fallback',
}

test('website version and release content follow repository authorities', () => {
  assert.ok(notes[`v${version}`])
  const page = releasesPage(catalog)
  assert.match(page, /v0\.2\.0/)
  assert.match(page, /Stable/)
  assert.match(page, /preview-only/)
  assert.match(page, /Oct 1, 2026/)
  assert.doesNotMatch(page, /0\.2\.0-rc\.19/)
})

test('homepage uses deployment cards and generated prototype assets', () => {
  const page = homePage(version)
  assert.match(page, /Portable[\s\S]*Dedicated[\s\S]*Private Cloud/)
  assert.doesNotMatch(page, /deployment-item[\s\S]*status-(?:stable|preview)/)
  for (const asset of ['hero-workbench.webp', 'ask-user-workflow.webp', 'subagent-activity.webp', 'tablet-session.webp', 'mobile-session.webp']) {
    assert.match(page, new RegExp(asset.replace('.', '\\.')))
    assert.match(page, new RegExp(asset.replace('.webp', '-dark\\.webp')))
  }
})

test('website render includes local illustration assets', async () => {
  const map = await readFile(resolve(root, 'packages/website/public/assets/illustration/world-map-cc0.svg'), 'utf8')
  assert.match(map, /viewBox="0 0 2048 1024"/)
})

test('all pages render semantic static HTML without remote runtime scripts', () => {
  const contents = [
    ['home', homePage(version)],
    ['download', downloadPage(catalog)],
    ['deploy', deployPage(version)],
    ['security', securityPage()],
    ['releases', releasesPage(catalog)],
  ]
  for (const [page, content] of contents) {
    const html = renderPage({
      version,
      page,
      title: 'Test',
      description: 'Test description.',
      content,
    })
    assert.match(html, /<main id="main">/)
    assert.match(html, /<script type="module" src="\/src\/main\.ts"><\/script>/)
    assert.doesNotMatch(html, /<script[^>]+https?:\/\//)
    assert.doesNotMatch(html, /fonts\.googleapis|googletagmanager|segment\.com|plausible\.io/)
    assert.match(html, /data-theme-toggle/)
    assert.doesNotMatch(html, /Kala contributors|Current stable release/)
  }
})

test('homepage prioritizes distinctive evidence and supports screenshot lightboxes', () => {
  const page = homePage(version)
  const rendered = renderPage({ version, page: 'home', title: 'Test', description: 'Test', content: page })
  assert.ok(page.indexOf('hero-workbench.webp') < page.indexOf('subagent-activity.webp'))
  assert.ok(page.indexOf('subagent-activity.webp') < page.indexOf('ask-user-workflow.webp'))
  assert.ok(page.indexOf('Explicit decisions.') < page.indexOf('Every screen.'))
  assert.match(page, /data-carousel="hero-scenes"/)
  assert.doesNotMatch(page, /mac-window-/)
  assert.doesNotMatch(page, /Portable is supported on Linux x64/)
  assert.match(page, /data-carousel="responsive-scenes"/)
  assert.equal((page.match(/data-lightbox-src=/g) ?? []).length, 8)
  assert.doesNotMatch(page, /scene-caption/)
  assert.doesNotMatch(page, /Explore DAG-first work|Explore subagent design|Read the protocol docs|Explore the architecture/)
  assert.match(page, /scene-arrow-previous[\s\S]*scene-arrow-next/)
  assert.match(page, /data-dag-demo[\s\S]*data-dag-node="release"/)
  assert.match(page, /<h1>Your <span>agent cloud\.<\/span><\/h1>/)
  assert.match(page, /deterministic agent system[\s\S]*models, workspaces, machines, and tenants/)
  assert.match(rendered, /Features[\s\S]*nav-github[\s\S]*data-dismiss-announcement/)
  assert.match(page, /One cloud\. Every workspace\./)
  assert.match(page, /Kala Agent Cloud/)
  assert.equal((page.match(/<path d="M500 66/g) ?? []).length, 5)
  assert.doesNotMatch(page, /Tenant A|Tenant B|Tenant C|Logical isolation|Control plane/)
  assert.match(page, /world-map-cc0\.svg/)
  assert.doesNotMatch(page, /network-cloud-shape/)
  assert.match(page, /iphone-11-pro-frame-cc0\.svg/)
  assert.match(page, /ipad-7-frame-cc0\.svg/)
  assert.doesNotMatch(page, /dag-demo-scroll/)
  assert.doesNotMatch(page, /cta-panel/)
  assert.doesNotMatch(page, /Open source · self-hosted|Agent Kernel transition/)
})

test('release catalog filters unpublished entries, parses public notes, and falls back safely', async () => {
  assert.equal(normalizeTag('v1.2.3'), 'v1.2.3')
  assert.equal(normalizeTag('not-a-release'), undefined)
  const published = {
    tag_name: 'v3.5.7-rc.1',
    draft: false,
    prerelease: true,
    published_at: '2026-09-01T00:00:00Z',
    html_url: 'https://github.com/kala-project/kala/releases/tag/v3.5.7-rc.1',
    body: '## Improvements\n\n- Public release note\n\n## Fixes\n\n- Public fix',
    assets: [],
  }
  let catalogUrl
  const resolved = await resolveReleaseCatalog({
    configuredVersion: 'v3.5.7-rc.1',
    fallbackCatalog,
    releaseNotes: notes,
    fetchImpl: async (url) => {
      catalogUrl = url
      return {
        ok: true,
        json: async () => [
          { ...published, draft: true, tag_name: 'v9.9.9', html_url: 'https://github.com/kala-project/kala/releases/tag/v9.9.9' },
          { ...published, published_at: null, tag_name: 'v8.8.8', html_url: 'https://github.com/kala-project/kala/releases/tag/v8.8.8' },
          published,
        ],
      }
    },
  })
  assert.equal(catalogUrl, 'https://api.github.com/repos/kala-project/kala/releases?per_page=100')
  assert.equal(resolved.current.tag, 'v3.5.7-rc.1')
  assert.equal(resolved.current.notes.improvements[0], 'Public release note')
  assert.equal(resolved.current.notes.fixes[0], 'Public fix')
  assert.equal(resolved.releases.length, 1)

  const fallback = await resolveReleaseCatalog({
    fallbackCatalog,
    releaseNotes: notes,
    configuredVersion: version,
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(fallback.source, 'fallback')
  assert.equal(fallback.stable.tag, 'v0.2.0')
  assert.equal(fallback.current.tag, 'v0.2.0', 'unpublished beta versions must not replace the published stable release')
  assert.equal(fallback.releases.some((release) => release.tag === 'v0.2.0-rc.19'), false)
})

test('download guidance matches the supported stable matrix', () => {
  const page = downloadPage(catalog)
  assert.match(page, /<h2>Linux<\/h2>[\s\S]*linux-portable-command/)
  assert.match(page, /macOS[\s\S]*Intel[\s\S]*Apple silicon/)
  assert.match(page, /Windows[\s\S]*Not supported yet/)
  assert.doesNotMatch(page, /Linux arm64/)
  assert.match(page, /Not supported yet/)
  assert.match(page, /SHA256SUMS/)
  assert.match(page, /Portable[\s\S]*Dedicated[\s\S]*Private Cloud/)
  assert.doesNotMatch(page, /dedicated-install-command|private-cloud-install-command|kala-private-cloud install|install-dedicated-systemd/)
  assert.doesNotMatch(page, /Install the verified Kala/)
  assert.match(page, /Signed evidence/)
  assert.doesNotMatch(page, /scanned preview artifacts/)
  assert.match(page, /releases\/download\/v0\.2\.0\/run\.sh/)
  assert.match(page, /releases\/download\/v0\.2\.0\/kala-host-linux-x64/)
})

test('published CJS releases offer the Portable manager and platform runtimes without inventing native Host binaries', () => {
  const assetNames = [
    'run.sh', 'SHA256SUMS', 'kala-dashboard-with-runtime.cjs', 'kala-portable.sh', 'kala-portable.ps1',
    'kala-copilot-runtime-linux-x64', 'kala-copilot-runtime-darwin-x64',
    'kala-copilot-runtime-darwin-arm64', 'kala-copilot-runtime-win32-x64',
    'kala-copilot-runtime-node-linux-x64.node', 'kala-copilot-runtime-node-darwin-x64.node',
    'kala-copilot-runtime-node-darwin-arm64.node', 'kala-copilot-runtime-node-win32-x64.node',
    'kala-dedicated-support.tar.gz',
    'kala-private-cloud-0.3.0-linux-x64.tar.gz',
  ]
  const release = {
    ...catalog.stable,
    tag: 'v0.3.0',
    version: '0.3.0',
    assets: assetNames.map((name) => ({
      name,
      url: `https://github.com/kala-project/kala/releases/download/v0.3.0/${name}`,
    })),
  }
  const cjsCatalog = { ...catalog, stable: release, current: release, releases: [release] }
  const download = downloadPage(cjsCatalog)
  const notesPage = releasesPage(cjsCatalog)
  assert.match(download, /releases\/download\/v0\.3\.0\/kala-dashboard-with-runtime\.cjs/)
  assert.match(download, /releases\/download\/v0\.3\.0\/kala-copilot-runtime-darwin-arm64/)
  assert.match(download, /releases\/download\/v0\.3\.0\/kala-portable\.ps1/)
  assert.doesNotMatch(download, /kala-host-linux-x64|Not supported yet/)
  assert.match(notesPage, /Portable Host[\s\S]*kala-portable\.sh/)
  assert.match(notesPage, /Windows[\s\S]*kala-portable\.ps1/)
  assert.throws(() => downloadPage({ ...cjsCatalog, stable: { ...release, assets: release.assets.filter((asset) => asset.name !== 'kala-copilot-runtime-linux-x64') } }), /missing required website asset kala-copilot-runtime-linux-x64/)
  assert.throws(() => releasesPage({ ...cjsCatalog, current: { ...release, assets: release.assets.filter((asset) => asset.name !== 'kala-copilot-runtime-node-win32-x64.node') } }), /missing required website asset kala-copilot-runtime-node-win32-x64.node/)
})

test('deploy page compares operating models without repeating homepage cards', () => {
  const page = deployPage(version)
  assert.match(page, /deployment-comparison/)
  assert.match(page, /Typical scenario[\s\S]*Pros[\s\S]*Cons/)
  assert.match(page, /One person or a small self-hosted installation/)
  assert.match(page, /A platform team serving multiple tenants/)
  assert.doesNotMatch(page, /deployment-grid/)
  assert.doesNotMatch(page, /prose-grid|cta-panel|Support boundary/)
})

test('release page follows a scannable update-notes structure', () => {
  const page = releasesPage(catalog)
  assert.match(page, /release-archive/)
  assert.match(page, /On this page/)
  assert.match(page, /Downloads for 0\.2\.0/)
  assert.match(page, /Release highlights/)
  assert.match(page, /Improvements[\s\S]*Fixes[\s\S]*Known boundaries[\s\S]*Release evidence/)
  assert.match(page, /releases\/download\/v0\.2\.0\/kala-host-darwin-arm64/)
})
