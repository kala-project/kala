import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import { deployPage, downloadPage, homePage, releasesPage, renderPage, securityPage } from './site-content.mjs'
import { normalizeReleases, normalizeTag, resolveReleaseCatalog, resolveReleaseChanges } from './release-catalog.mjs'

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
const publishedVersion = catalog.stable.version
const modernAssets = [
  'run.sh', 'SHA256SUMS', 'SHA256SUMS.sigstore.json', 'kala-dashboard-with-runtime.cjs', 'kala-portable.sh', 'kala-portable.ps1',
  'kala-dedicated-support.tar.gz', `kala-private-cloud-${publishedVersion}-linux-x64.tar.gz`,
]
const modernRelease = {
  ...catalog.stable,
  assets: modernAssets.map((name) => ({
    name,
    url: `https://github.com/kala-project/kala/releases/download/${catalog.stable.tag}/${name}`,
  })),
}
const modernCatalog = { ...catalog, stable: modernRelease, current: modernRelease, releases: [modernRelease] }

test('website version and release content follow repository authorities', () => {
  assert.ok(notes[`v${version}`])
  const page = releasesPage(catalog)
  assert.match(page, /Downloads for 0\.4\.2/)
  assert.match(page, /v0\.4\.2/)
  assert.match(page, /Stable/)
  assert.match(page, /Nov 9, 2026/)
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
  assert.equal(fallback.stable.tag, catalog.stable.tag)
  assert.equal(fallback.current.tag, catalog.stable.tag, 'the published stable release must be available offline')
  assert.equal(fallback.current.assets.length, 24)
  assert.equal(fallback.releases.some((release) => release.tag === 'v0.4.0'), true)
  assert.equal(fallback.releases.some((release) => release.tag === 'v0.2.0-rc.19'), false)
})

test('download guidance matches the supported stable matrix', () => {
  const page = downloadPage(modernCatalog)
  assert.match(page, /<h2>Linux<\/h2>[\s\S]*linux-portable-command/)
  assert.match(page, /macOS[\s\S]*Intel[\s\S]*Apple silicon/)
  assert.match(page, /<h2>Windows<\/h2>[\s\S]*windows-portable-command[\s\S]*Asset · PowerShell manager/)
  assert.match(page, /Invoke-WebRequest[\s\S]*SHA256SUMS\.sigstore\.json[\s\S]*cosign verify-blob[\s\S]*Get-FileHash[\s\S]*&amp; \.\\kala-portable\.ps1 install[\s\S]*&amp; \.\\kala-portable\.ps1 start/)
  assert.match(page, /release\.yml@refs\/tags\/v0\.4\.2/)
  assert.match(page, /Checksum mismatch/)
  assert.doesNotMatch(page, /Invoke-Expression|iex\b/)
  assert.doesNotMatch(page, /Linux arm64/)
  assert.doesNotMatch(page, /Not supported yet/)
  assert.match(page, /SHA256SUMS/)
  assert.match(page, /Portable[\s\S]*Dedicated[\s\S]*Private Cloud/)
  assert.doesNotMatch(page, /dedicated-install-command|private-cloud-install-command|kala-private-cloud install|install-dedicated-systemd/)
  assert.doesNotMatch(page, /Install the verified Kala/)
  assert.doesNotMatch(page, /Verify before you run|Signed evidence|Versioned manifest/)
  assert.doesNotMatch(page, /scanned preview artifacts/)
  assert.match(page, /releases\/download\/v0\.4\.2\/run\.sh/)
  assert.match(page, /releases\/download\/v0\.4\.2\/kala-dashboard-with-runtime\.cjs/)
  const legacyPage = downloadPage({ ...catalog, stable: releases.find((release) => release.tag === 'v0.2.0') })
  assert.match(legacyPage, /Windows[\s\S]*Not supported yet/)
  assert.match(legacyPage, /releases\/download\/v0\.2\.0\/kala-host-linux-x64/)
})

test('published CJS releases offer the Portable Host without redistributing Copilot binaries', () => {
  const assetNames = [
    'run.sh', 'SHA256SUMS', 'SHA256SUMS.sigstore.json', 'kala-dashboard-with-runtime.cjs', 'kala-portable.sh', 'kala-portable.ps1',
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
  assert.doesNotMatch(download, /kala-copilot-runtime-/)
  assert.match(download, /releases\/download\/v0\.3\.0\/kala-portable\.ps1/)
  assert.doesNotMatch(download, /kala-host-linux-x64|Not supported yet/)
  assert.match(notesPage, /Portable Host[\s\S]*kala-portable\.sh/)
  assert.match(notesPage, /Windows[\s\S]*kala-portable\.ps1/)
  assert.throws(() => downloadPage({ ...cjsCatalog, stable: { ...release, assets: release.assets.filter((asset) => asset.name !== 'kala-portable.sh') } }), /missing required website asset kala-portable.sh/)
  assert.throws(() => downloadPage({ ...cjsCatalog, stable: { ...release, assets: release.assets.filter((asset) => asset.name !== 'SHA256SUMS.sigstore.json') } }), /missing required website asset SHA256SUMS.sigstore.json/)
  assert.throws(() => releasesPage({ ...cjsCatalog, current: { ...release, assets: release.assets.filter((asset) => asset.name !== 'kala-portable.ps1') } }), /missing required website asset kala-portable.ps1/)
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
  const page = releasesPage(modernCatalog)
  assert.match(page, /release-archive/)
  assert.match(page, /On this page/)
  assert.match(page, /Downloads for 0\.4\.2/)
  assert.match(page, /Release overview/)
  assert.match(page, /0 improvements[\s\S]*3 fixes/)
  assert.match(page, /Improvements[\s\S]*Fixes[\s\S]*Known boundaries[\s\S]*Full changelog[\s\S]*Verification files/)
  assert.match(page, /Copilot sessions require the official Copilot CLI/)
  assert.doesNotMatch(page, /kala-copilot-runtime-/)
})

test('release page exposes the preceding release and complete tagged commit history', async () => {
  const release = catalog.current
  const prior = releases.find((entry) => entry.tag === release.previousTag)
  const sha = 'a'.repeat(40)
  const changes = await resolveReleaseChanges(release, {
    fetchImpl: async (url) => {
      assert.match(url, /compare\/v0\.4\.1\.\.\.v0\.4\.2\?per_page=100$/)
      return {
        ok: true,
        json: async () => ({ total_commits: 1, commits: [{ sha, commit: { message: 'A real change\nDetails' } }] }),
      }
    },
  })
  const page = releasesPage(catalog, { [release.tag]: changes })
  assert.match(page, /href="#previous-release"[\s\S]*0\.4\.1/)
  assert.match(page, /<option value="#previous-release">0\.4\.1/)
  assert.match(page, /Dedicated Owner management presents Identity/)
  assert.match(page, /compare\/v0\.4\.0\.\.\.v0\.4\.1/)
  assert.match(page, new RegExp(`commit/${sha}">A real change`))
  assert.doesNotMatch(page, /Dashboard workflow<\/a>:|Runtime fixes<\/a>:|Support boundaries<\/a>:/)
  assert.equal(prior.tag, 'v0.4.1')

  const truncated = await resolveReleaseChanges(release, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ total_commits: 2, commits: [{ sha, commit: { message: 'Incomplete' } }] }),
    }),
  })
  assert.deepEqual(truncated.commits, [])
  assert.doesNotMatch(releasesPage(catalog, { [release.tag]: truncated }), /Incomplete/)
})
