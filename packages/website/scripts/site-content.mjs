import { heroScenes, responsiveScenes } from './product-scenes.mjs'
import { releaseAsset } from './release-catalog.mjs'

export function renderPage({ version, page, title, description, content, origin, base = '/' }) {
  const canonicalPath = page === 'home' ? '/' : `/${page}/`
  const canonical = origin ? `<link rel="canonical" href="${escapeAttribute(new URL(canonicalPath, origin).href)}">` : ''
  const socialImage = origin
    ? `<meta property="og:image" content="${escapeAttribute(new URL('/assets/product/hero-workbench.webp', origin).href)}">
    <meta name="twitter:card" content="summary_large_image">`
    : ''
  const current = (name) => page === name ? ' aria-current="page"' : ''
  const html = `<!doctype html>
<html lang="en" data-release-version="${escapeAttribute(version)}">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${escapeAttribute(description)}">
    <meta name="theme-color" content="#0c1420" data-theme-color>
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeAttribute(title)}">
    <meta property="og:description" content="${escapeAttribute(description)}">
    ${socialImage}
    ${canonical}
    <link rel="icon" href="/assets/brand/kala-icon.svg" type="image/svg+xml">
    <script>
      try {
        const savedTheme = localStorage.getItem('kala-site-theme')
        document.documentElement.dataset.theme = savedTheme === 'light' || savedTheme === 'dark'
          ? savedTheme
          : 'dark'
        if (localStorage.getItem('kala-release-notice') === '${escapeAttribute(version)}') {
          document.documentElement.dataset.releaseNotice = 'hidden'
        }
      } catch {
        document.documentElement.dataset.theme = 'dark'
      }
    </script>
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="nav-shell">
        <a class="brand" href="/" aria-label="Kala home">
          ${brandImages()}
        </a>
        <button class="menu-button" type="button" aria-label="Open navigation" aria-expanded="false" data-menu-button>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <nav class="site-navigation" aria-label="Main navigation" data-site-navigation>
          <div class="nav-links">
            <a class="nav-link" href="/#features">Features</a>
            <a class="nav-link" href="https://github.com/kala-project/kala/tree/main/docs">Docs</a>
            <a class="nav-link" href="/releases/"${current('releases')}>Releases</a>
            <a class="nav-link" href="/deploy/"${current('deploy')}>Deploy</a>
          </div>
          <div class="nav-actions">
            <a class="nav-link nav-github" href="https://github.com/kala-project/kala">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5a9.5 9.5 0 0 0-3 18.51c.48.09.66-.2.66-.46v-1.68c-2.69.58-3.26-1.14-3.26-1.14-.44-1.12-1.08-1.42-1.08-1.42-.88-.6.07-.59.07-.59.97.07 1.48 1 1.48 1 .87 1.48 2.27 1.05 2.82.8.09-.63.34-1.05.62-1.29-2.15-.24-4.41-1.07-4.41-4.78 0-1.06.38-1.92 1-2.6-.1-.24-.43-1.23.09-2.56 0 0 .81-.26 2.66.99A9.25 9.25 0 0 1 12 6.95a9.2 9.2 0 0 1 2.42.33c1.84-1.25 2.65-.99 2.65-.99.52 1.33.19 2.32.1 2.56.62.68.99 1.54.99 2.6 0 3.72-2.27 4.53-4.42 4.77.35.3.65.89.65 1.8v2.53c0 .26.18.56.66.46A9.5 9.5 0 0 0 12 2.5Z" fill="currentColor"/></svg>
              <span>GitHub</span>
            </a>
            <button class="theme-button" type="button" aria-label="Switch color theme" title="Switch color theme" data-theme-toggle>
              <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"/></svg>
              <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"/></svg>
            </button>
            <a class="nav-button" href="/download/"${current('download')}>Download</a>
          </div>
        </nav>
      </div>
      <div class="site-announcement">
        <span>Kala ${escapeHtml(version)} is available. <a href="/releases/">Read the release notes</a></span>
        <button type="button" aria-label="Dismiss release announcement" data-dismiss-announcement>×</button>
      </div>
    </header>
    <main id="main">${content}</main>
    ${footer()}
    <dialog class="image-lightbox" data-image-lightbox aria-label="Product screenshot preview">
      <button class="lightbox-close" type="button" aria-label="Close screenshot preview" data-lightbox-close>×</button>
      <img alt="" data-lightbox-image>
    </dialog>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>`
  return applySiteBase(html, base)
}

export function homePage(version) {
  return `
    <section class="hero">
      <div class="section-shell">
        <div class="hero-copy">
          <h1>Your <span>agent cloud.</span></h1>
          <p class="hero-lede">Operate one deterministic agent system across the models, workspaces, machines, and tenants you choose.</p>
          <div class="hero-actions">
            <a class="button button-primary" href="/download/" data-platform-label>Download Kala</a>
            <a class="button button-secondary" href="https://github.com/kala-project/kala">View on GitHub</a>
          </div>
        </div>
        ${sceneCarousel('hero-scenes', heroScenes, 'hero-carousel')}
        <div class="trust-row" aria-label="Kala product qualities">
          <div class="trust-item"><strong>One contract</strong><span>Consistent behavior across models and deployments</span></div>
          <div class="trust-item"><strong>Work anywhere</strong><span>Outbound Executors connect the machines you use</span></div>
          <div class="trust-item"><strong>Multi-tenant</strong><span>Isolated Runtime Units share one platform</span></div>
        </div>
      </div>
    </section>

    ${workspaceNetworkSection()}

    <section class="content-section tint" id="features">
      <div class="section-shell">
        <div class="section-heading center">
          <p class="eyebrow">One working environment</p>
          <h2>One workspace. Full context.</h2>
          <p>Kala keeps the conversation, model activity, tools, approvals, files, context, and delegated work in one production interface.</p>
        </div>
        <div class="feature-row">
          <div class="feature-copy">
            <p class="eyebrow">DAG-first planning</p>
            <h2>Plan as a graph.</h2>
            <p>See parallel branches, blockers, and the path to done.</p>
            <ul>
              <li>Real dependencies, not a flat checklist</li>
              <li>Graph and list views from the Composer</li>
              <li>Durable revisions for recovery</li>
            </ul>
          </div>
          ${dagExecutionDemo()}
        </div>
        <div class="feature-row reverse">
          <div class="feature-copy">
            <h2>Agents, coordinated.</h2>
            <p>Follow parent and child sessions together, inspect nested Tool activity, and understand which delegated work completed, failed, or was cancelled.</p>
            <ul>
              <li>Parallel subagent lifecycle visibility</li>
              <li>Nested activity and intention details</li>
              <li>Durable parent-child session relationships</li>
            </ul>
          </div>
          <figure class="feature-visual zoomable-frame">
            <button class="image-zoom" type="button" data-lightbox-src="/assets/product/subagent-activity.webp" data-lightbox-alt="Kala Dashboard displaying running, completed, failed, cancelled, and idle subagent activity" aria-label="Enlarge the subagent activity screenshot">
              ${themePicture({
                asset: 'subagent-activity.webp',
                darkAsset: 'subagent-activity-dark.webp',
                mobileAsset: 'mobile-session.webp',
                mobileDarkAsset: 'mobile-session-dark.webp',
                alt: 'Kala Dashboard displaying running, completed, failed, cancelled, and idle subagent activity',
              }, false)}
            </button>
          </figure>
        </div>
        <div class="feature-row">
          <div class="feature-copy">
            <h2>Explicit decisions.</h2>
            <p>Human input is a durable part of the workflow. Choices and approvals remain visible across reconnects and planned restarts without blocking unrelated work.</p>
            <ul>
              <li>Single-choice, multi-choice, and custom responses</li>
              <li>Explicit approval and rejection boundaries</li>
              <li>No hidden success when input is still required</li>
            </ul>
          </div>
          <figure class="feature-visual zoomable-frame">
            <button class="image-zoom" type="button" data-lightbox-src="/assets/product/ask-user-workflow.webp" data-lightbox-alt="Kala session showing a compact Ask User choice workflow with readable option descriptions" aria-label="Enlarge the choice workflow screenshot">
              ${themePicture({
                asset: 'ask-user-workflow.webp',
                darkAsset: 'ask-user-workflow-dark.webp',
                alt: 'Kala session showing a compact Ask User choice workflow with readable option descriptions',
              }, false)}
            </button>
          </figure>
        </div>
        <div class="feature-row responsive-feature">
          <div class="feature-copy">
            <h2>Every screen.</h2>
            <p>Phone. Tablet. Desktop.</p>
          </div>
          ${sceneCarousel('responsive-scenes', responsiveScenes, 'responsive-carousel')}
        </div>
      </div>
    </section>

    <section class="content-section deploy-comparison-section">
      <div class="section-shell">
        <div class="section-heading">
          <p class="eyebrow">Built for long-running work</p>
          <h2>A solid core behind every session.</h2>
          <p>Kala keeps agent work predictable, recoverable, and inspectable through reconnects, retries, restarts, and delegated work.</p>
        </div>
        <div class="architecture-grid">
          <article class="architecture-item">
            <span class="architecture-index">01 / Reliable core</span>
            <h3>Predictable under pressure</h3>
            <p>Explicit state keeps failures, retries, and completion from turning into guesswork.</p>
          </article>
          <article class="architecture-item">
            <span class="architecture-index">02 / Durable sessions</span>
            <h3>Work survives interruption</h3>
            <p>Messages, tools, approvals, and delegated work recover across reconnects and planned restarts.</p>
          </article>
          <article class="architecture-item">
            <span class="architecture-index">03 / Controlled execution</span>
            <h3>Work stays close to the code</h3>
            <p>Clear execution boundaries keep tools useful while preserving operator control over real workspaces.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="content-section">
      <div class="section-shell">
        <div class="section-heading center">
          <p class="eyebrow">Choose the operating boundary</p>
          <h2>Deploy on your terms.</h2>
        </div>
        ${deploymentCards()}
      </div>
    </section>

  `
}

export function downloadPage(catalog) {
  const release = catalog.stable ?? catalog.current
  const version = release.version
  const portableCjs = Boolean(releaseAsset(release, 'kala-dashboard-with-runtime.cjs'))
  if (portableCjs) requirePortableManagerAssets(release)
  const runUrl = requiredAssetUrl(release, 'run.sh')
  const command = `set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL ${runUrl} | bash`
  const windowsCommand = portableCjs ? [
    "$ErrorActionPreference = 'Stop'",
    'if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }',
    `$base = 'https://github.com/kala-project/kala/releases/download/${release.tag}'`,
    'Invoke-WebRequest "$base/kala-portable.ps1" -OutFile .\\kala-portable.ps1',
    'Invoke-WebRequest "$base/SHA256SUMS" -OutFile .\\SHA256SUMS',
    'Invoke-WebRequest "$base/SHA256SUMS.sigstore.json" -OutFile .\\SHA256SUMS.sigstore.json',
    `cosign verify-blob --bundle .\\SHA256SUMS.sigstore.json --certificate-identity "https://github.com/kala-project/kala/.github/workflows/release.yml@refs/tags/${release.tag}" --certificate-oidc-issuer https://token.actions.githubusercontent.com .\\SHA256SUMS`,
    "if ($LASTEXITCODE -ne 0) { throw 'Signature verification failed' }",
    "$entries = @(Select-String -Path .\\SHA256SUMS -Pattern '^[a-f0-9]{64}  kala-portable\\.ps1$')",
    "if ($entries.Count -ne 1 -or (Get-FileHash .\\kala-portable.ps1 -Algorithm SHA256).Hash -ne $entries[0].Matches.Value.Substring(0, 64)) { throw 'Checksum mismatch' }",
    '& .\\kala-portable.ps1 install',
    '& .\\kala-portable.ps1 start',
  ].join('\n') : ''
  const dedicatedUrl = requiredAssetUrl(release, 'kala-dedicated-support.tar.gz')
  const privateCloudUrl = requiredAssetUrl(release, `kala-private-cloud-${version}-linux-x64.tar.gz`)
  return `
    <section class="page-hero download-hero">
      <div class="section-shell">
        <h1>Download Kala</h1>
      </div>
    </section>
    <section class="content-section download-options">
      <div class="section-shell">
        <div class="download-mode-switcher" role="tablist" aria-label="Deployment mode">
          <button type="button" role="tab" aria-selected="true" aria-controls="download-panel-portable" data-download-mode="portable">Portable</button>
          <button type="button" role="tab" aria-selected="false" aria-controls="download-panel-dedicated" data-download-mode="dedicated">Dedicated</button>
          <button type="button" role="tab" aria-selected="false" aria-controls="download-panel-private-cloud" data-download-mode="private-cloud">Private Cloud</button>
        </div>
        <section class="download-mode-panel" id="download-panel-portable" role="tabpanel" data-download-panel="portable">
          <div class="download-platform-grid">
            ${downloadPlatformCard('linux', 'Linux', portableCjs ? 'x64 · Node.js 22+' : 'x64', portableCjs ? 'Asset' : 'Portable', portableCjs ? [{ label: 'Host CJS', asset: 'kala-dashboard-with-runtime.cjs' }] : [{ label: 'x64', asset: 'kala-host-linux-x64' }], release, command)}
            ${downloadPlatformCard('apple', 'macOS', portableCjs ? 'macOS 13+ · Intel / Apple silicon · Node.js 22+' : 'macOS 13+', portableCjs ? 'Asset' : 'Portable', portableCjs ? [{ label: 'Host CJS', asset: 'kala-dashboard-with-runtime.cjs' }] : [{ label: 'Intel', asset: 'kala-host-darwin-x64' }, { label: 'Apple silicon', asset: 'kala-host-darwin-arm64' }], release, command)}
            ${portableCjs ? downloadPlatformCard('windows', 'Windows', 'x64 · Node.js 22+ · PowerShell 5.1+', 'Asset', [
              { label: 'Host CJS', asset: 'kala-dashboard-with-runtime.cjs' },
              { label: 'PowerShell manager', asset: 'kala-portable.ps1' },
            ], release, windowsCommand, 'Requires Cosign. Verifies the manager, then installs and starts the per-user Portable Host.') : `<article class="download-platform is-unavailable">
              ${machineIcon('windows')}
              <h2>Windows</h2>
              <p class="download-not-supported">Not supported yet</p>
            </article>`}
          </div>
          ${portableCjs ? '<p>To use Copilot sessions, install the official Copilot CLI separately on this machine; Kala does not distribute it.</p>' : ''}
        </section>
        <section class="download-mode-panel deployment-download-panel deployment-download-panel-compact" id="download-panel-dedicated" role="tabpanel" data-download-panel="dedicated" hidden>
          <div>
            <p class="eyebrow">Preview · Single tenant</p>
            <h2>Dedicated</h2>
            <p>Download the immutable Dedicated bundle, prepare the target configuration, then run the bundled systemd operator from an external administrative shell.</p>
            <div class="download-mode-actions">
              <a class="button button-primary" href="${escapeAttribute(dedicatedUrl)}">Download bundle</a>
              <a class="button button-secondary" href="https://github.com/kala-project/kala/blob/main/docs/operations/dedicated-operator-cli.md">Operator runbook</a>
            </div>
          </div>
        </section>
        <section class="download-mode-panel deployment-download-panel deployment-download-panel-compact" id="download-panel-private-cloud" role="tabpanel" data-download-panel="private-cloud" hidden>
          <div>
            <p class="eyebrow">Preview · Multi-tenant</p>
            <h2>Private Cloud</h2>
            <p>Download the versioned Compose bundle, provide operator-owned configuration and secrets, then run the bundled lifecycle CLI.</p>
            <div class="download-mode-actions">
              <a class="button button-primary" href="${escapeAttribute(privateCloudUrl)}">Download bundle</a>
              <a class="button button-secondary" href="https://github.com/kala-project/kala/blob/main/docs/operations/private-cloud-release.md">Operator runbook</a>
            </div>
          </div>
        </section>
        <p class="download-other-modes">Need an always-on or multi-tenant installation? <a href="/deploy/">Compare deployment modes →</a></p>
      </div>
    </section>
  `
}

export function deployPage(version) {
  return `
    ${pageHero('Deploy', 'Choose the operating model that fits.', 'Compare who each mode serves, what it simplifies, and what you must operate.')}
    <section class="content-section">
      <div class="section-shell">
        ${deploymentComparison()}
      </div>
    </section>
  `
}

export function securityPage() {
  return `
    ${pageHero('Security', 'Control the boundaries that touch code, credentials, and durable state.', 'Kala separates browser identity, agent state, model credentials, workspace execution, and deployment authority rather than collapsing them into one process or token.')}
    <section class="content-section">
      <div class="section-shell prose-grid">
        ${sideIndex([['execution', 'Workspace execution'], ['state', 'Durable state'], ['credentials', 'Credentials'], ['supply-chain', 'Supply chain'], ['report', 'Report']])}
        <div class="prose-content">
          <section id="execution">
            <h2>Workspace execution</h2>
            <p>Executors dial out to the Host. They advertise an explicit tool and sandbox boundary, and the Dashboard never talks to an Executor directly. Approval remains Runtime authority.</p>
          </section>
          <section id="state">
            <h2>Durable state</h2>
            <p>Session events are persisted before they are projected as completed work. Queue acceptance, planned restart continuation, deployment receipts, and route generations have explicit durability and fencing contracts.</p>
          </section>
          <section id="credentials">
            <h2>Credential ownership</h2>
            <p>Provider credentials and deployment secrets remain server-side. They are not embedded in the Dashboard, Session events, public evidence, screenshots, or release metadata.</p>
          </section>
          <section id="supply-chain">
            <h2>Supply-chain controls</h2>
            <p>Direct dependencies are pinned, the pnpm lockfile is immutable in CI, new releases observe a cooling period, and release assets carry manifests, checksums, scans, and signed evidence.</p>
            <ul>
              <li>Exact dependency versions and reviewed lifecycle scripts</li>
              <li>Privacy, license, vulnerability, and package-boundary gates</li>
              <li>Immutable release revisions and digest-pinned Private Cloud images</li>
            </ul>
          </section>
          <section id="report">
            <h2>Report a vulnerability</h2>
            <p>Do not open a public issue containing an undisclosed vulnerability, credentials, private installation data, or customer content.</p>
            <a class="button button-primary" href="https://github.com/kala-project/kala/security/policy">Read the security policy</a>
          </section>
        </div>
      </div>
    </section>
  `
}

export function releasesPage(catalog, changeLog = {}) {
  const current = catalog.current
  const version = current.version
  const previous = catalog.releases.find((release) => release.tag === current.previousTag)
  const portableCjs = Boolean(releaseAsset(current, 'kala-dashboard-with-runtime.cjs'))
  if (portableCjs) requirePortableManagerAssets(current)
  const improvements = current.notes.improvements
  const fixes = current.notes.fixes
  const knownIssues = current.notes.knownIssues
  const status = current.prerelease ? 'Preview' : 'Stable'
  const archive = catalog.releases.map((release) => release.tag === current.tag
    ? `<li class="is-current"><a href="/releases/" aria-current="page"><span>${escapeHtml(release.version)}</span><small>${releaseStatus(release)} · ${releaseDate(release)}</small></a></li>`
    : `<li><a href="${escapeAttribute(release.tag === previous?.tag ? '#previous-release' : release.url)}"><span>${escapeHtml(release.version)}</span><small>${releaseStatus(release)} · ${releaseDate(release)}</small></a></li>`).join('')
  const linuxUrl = portableCjs ? null : requiredAssetUrl(current, 'kala-host-linux-x64')
  const macIntelUrl = portableCjs ? null : requiredAssetUrl(current, 'kala-host-darwin-x64')
  const macArmUrl = portableCjs ? null : requiredAssetUrl(current, 'kala-host-darwin-arm64')
  const portableManagerUrl = portableCjs ? requiredAssetUrl(current, 'kala-portable.sh') : null
  const windowsManagerUrl = portableCjs ? requiredAssetUrl(current, 'kala-portable.ps1') : null
  const checksumsUrl = requiredAssetUrl(current, 'SHA256SUMS')
  return `
    <section class="release-docs">
      <div class="section-shell release-docs-grid">
        <aside class="release-archive">
          <nav aria-label="Releases">
            <h2>Releases</h2>
            <ul>${archive}</ul>
          </nav>
          <label for="release-archive-select">Releases</label>
          <select id="release-archive-select" aria-label="Releases">
            ${catalog.releases.map((release) => `<option value="${escapeAttribute(release.tag === current.tag ? '#highlights' : release.tag === previous?.tag ? '#previous-release' : release.url)}"${release.tag === current.tag ? ' selected' : ''}>${escapeHtml(release.version)} · ${releaseStatus(release)}</option>`).join('')}
          </select>
        </aside>
        <article class="release-article">
          <h1>Kala ${escapeHtml(version)}</h1>
          <p class="release-metadata"><span>${status}</span><time datetime="${escapeAttribute(current.publishedAt)}">${releaseDate(current)}</time><a href="${escapeAttribute(current.url)}">View on GitHub</a></p>
          <details class="release-downloads">
            <summary><h2>Downloads for ${escapeHtml(version)}</h2></summary>
            <dl>
              ${portableCjs ? `<div><dt>Portable Host</dt><dd><a href="${escapeAttribute(requiredAssetUrl(current, 'kala-dashboard-with-runtime.cjs'))}">CJS · Node.js 22+</a><a href="${escapeAttribute(portableManagerUrl)}">POSIX manager</a></dd></div>` : ''}
              ${portableCjs ? '' : `<div><dt>Linux</dt><dd><a href="${escapeAttribute(linuxUrl)}">x64</a></dd></div>
              <div><dt>macOS</dt><dd><a href="${escapeAttribute(macIntelUrl)}">Intel</a><a href="${escapeAttribute(macArmUrl)}">Apple silicon</a></dd></div>`}
              <div><dt>Windows</dt><dd>${windowsManagerUrl ? `<a href="${escapeAttribute(windowsManagerUrl)}">Portable PowerShell manager</a>` : 'Not available'}</dd></div>
            </dl>
          </details>
          ${portableCjs ? '<p>Copilot sessions require the official Copilot CLI, installed separately by the operator on the Host machine.</p>' : ''}
          <p class="release-update-guidance">Already installed? Use the verified stable bootstrapper to update the Portable installation.</p>
          <section id="highlights" class="release-highlights">
            <h2>Release overview</h2>
            <p>These are the published notes for ${escapeHtml(current.tag)}, not a cumulative feature list.${previous ? ` For the larger preceding release, see <a href="#previous-release">${escapeHtml(previous.tag)} below</a>.` : ''}</p>
            <ul>
              <li><a href="#improvements">${improvements.length} improvement${improvements.length === 1 ? '' : 's'}</a> and <a href="#fixes">${fixes.length} fix${fixes.length === 1 ? '' : 'es'}</a> in this release</li>
              ${current.previousTag ? `<li><a href="#changes">Full changelog since ${escapeHtml(current.previousTag)}</a></li>` : ''}
            </ul>
          </section>
          <hr><section id="improvements"><h2>Improvements</h2>${list(improvements)}</section>
          <hr><section id="fixes"><h2>Fixes</h2>${list(fixes)}</section>
          <hr><section id="known"><h2>Known boundaries</h2>${list(knownIssues)}</section>
          ${releaseChanges(current, changeLog[current.tag], 'changes')}
          <hr><section id="evidence">
            <h2>Verification files</h2>
            <p><a href="${escapeAttribute(checksumsUrl)}">SHA256SUMS</a>${releaseAsset(current, 'SHA256SUMS.sigstore.json') ? ` · <a href="${escapeAttribute(requiredAssetUrl(current, 'SHA256SUMS.sigstore.json'))}">Sigstore bundle</a>` : ''} · <a href="https://github.com/kala-project/kala/actions">Release workflows</a></p>
          </section>
          ${previous ? `
          <hr><section id="previous-release">
            <h2>Kala ${escapeHtml(previous.version)}</h2>
            <p class="release-metadata"><span>${releaseStatus(previous)}</span><time datetime="${escapeAttribute(previous.publishedAt)}">${releaseDate(previous)}</time><a href="${escapeAttribute(previous.url)}">View on GitHub</a></p>
            <h3>Improvements</h3>${list(previous.notes.improvements)}
            <h3>Fixes</h3>${list(previous.notes.fixes)}
            <h3>Known boundaries</h3>${list(previous.notes.knownIssues)}
            ${releaseChanges(previous, changeLog[previous.tag], 'previous-changes')}
          </section>` : ''}
        </article>
        <aside class="release-on-this-page">
          <nav aria-label="On this page">
            <h2>On this page</h2>
            <ul>
              <li><a href="#highlights">Release overview</a></li>
              <li><a href="#improvements">Improvements</a></li>
              <li><a href="#fixes">Fixes</a></li>
              <li><a href="#known">Known boundaries</a></li>
              ${current.previousTag ? '<li><a href="#changes">Full changelog</a></li>' : ''}
              <li><a href="#evidence">Verification files</a></li>
              ${previous ? `<li><a href="#previous-release">${escapeHtml(previous.tag)} notes</a></li>` : ''}
            </ul>
          </nav>
        </aside>
      </div>
    </section>
  `
}

function releaseChanges(release, changes, id) {
  if (!release.previousTag) return ''
  const compareUrl = `https://github.com/kala-project/kala/compare/${release.previousTag}...${release.tag}`
  return `
    <hr><section id="${id}">
      <h2>Full changelog · ${escapeHtml(release.tag)}</h2>
      <p><a href="${escapeAttribute(compareUrl)}">Compare ${escapeHtml(release.previousTag)}...${escapeHtml(release.tag)} on GitHub</a>${changes?.commits.length ? ` · ${changes.commits.length} commits` : ''}</p>
      ${changes?.commits.length ? `<details><summary>Show all ${changes.commits.length} commits</summary><ol>${changes.commits.map(({ sha, title }) => `<li><a href="https://github.com/kala-project/kala/commit/${sha}">${escapeHtml(title)}</a></li>`).join('')}</ol></details>` : ''}
    </section>
  `
}

function sceneCarousel(id, scenes, variant) {
  const slides = scenes.map((scene, index) => scene.kind === 'device-pair' ? `
    <figure class="scene-slide${index === 0 ? ' is-active' : ''}" data-carousel-slide data-scene="${escapeAttribute(scene.label)}" aria-hidden="${index === 0 ? 'false' : 'true'}">
      <div class="scene-image responsive-device-pair" aria-label="${escapeAttribute(scene.alt)}">
        ${deviceMockup('phone', scene.phoneAsset, scene.phoneDarkAsset, 'Kala Dashboard on an iPhone-sized screen')}
        ${deviceMockup('tablet', scene.tabletAsset, scene.tabletDarkAsset, 'Kala Dashboard on an iPad-sized screen')}
      </div>
    </figure>
  ` : `
    <figure class="scene-slide${index === 0 ? ' is-active' : ''}" data-carousel-slide data-scene="${escapeAttribute(scene.label)}" aria-hidden="${index === 0 ? 'false' : 'true'}">
      <button class="image-zoom scene-image" type="button" data-lightbox-src="/assets/product/${escapeAttribute(scene.asset)}" data-lightbox-alt="${escapeAttribute(scene.alt)}" aria-label="Enlarge ${escapeAttribute(scene.label)} screenshot">
        ${themePicture(scene, index === 0 && variant === 'hero-carousel')}
      </button>
    </figure>
  `).join('')
  return `<div class="scene-carousel ${escapeAttribute(variant)}" data-carousel="${escapeAttribute(id)}" data-carousel-autoplay="true">
    <div class="scene-viewport" data-carousel-viewport>
      <div class="scene-track" data-carousel-track>${slides}</div>
    </div>
    <button class="scene-arrow scene-arrow-previous" type="button" data-carousel-previous aria-label="Previous scene">‹</button>
    <button class="scene-arrow scene-arrow-next" type="button" data-carousel-next aria-label="Next scene">›</button>
  </div>`
}

function themePicture(scene, priority) {
  const loadAttribute = priority ? 'fetchpriority="high"' : 'loading="lazy"'
  return `<picture class="theme-picture theme-picture-light">
    ${scene.mobileAsset ? `<source media="(max-width: 620px)" srcset="/assets/product/${escapeAttribute(scene.mobileAsset)}">` : ''}
    <img src="/assets/product/${escapeAttribute(scene.asset)}" alt="${escapeAttribute(scene.alt)}" width="1440" height="900" ${loadAttribute}>
  </picture>
  <picture class="theme-picture theme-picture-dark">
    ${scene.mobileDarkAsset ? `<source media="(max-width: 620px)" srcset="/assets/product/${escapeAttribute(scene.mobileDarkAsset)}">` : ''}
    <img src="/assets/product/${escapeAttribute(scene.darkAsset)}" alt="${escapeAttribute(scene.alt)}" width="1440" height="900" loading="lazy">
  </picture>`
}

function deviceMockup(kind, asset, darkAsset, alt) {
  const frame = kind === 'phone' ? 'iphone-11-pro-frame-cc0.svg' : 'ipad-7-frame-cc0.svg'
  return `<button class="device-mockup device-mockup-${kind}" type="button" data-lightbox-src="/assets/product/${escapeAttribute(asset)}" data-lightbox-alt="${escapeAttribute(alt)}" aria-label="Enlarge ${escapeAttribute(kind)} screenshot">
    <span class="device-screen">
      <img class="theme-image-light" src="/assets/product/${escapeAttribute(asset)}" alt="${escapeAttribute(alt)}" loading="lazy">
      <img class="theme-image-dark" src="/assets/product/${escapeAttribute(darkAsset)}" alt="${escapeAttribute(alt)}" loading="lazy">
    </span>
    <img class="device-frame" src="/assets/illustration/${frame}" alt="" loading="lazy">
  </button>`
}

function dagExecutionDemo() {
  return `<div class="dag-demo" data-dag-demo aria-label="Animated Task Graph showing dependencies unlocking parallel work">
    <div class="dag-demo-toolbar">
      <div class="dag-demo-heading"><strong>Task Graph</strong><span>7 tasks · 9 dependencies</span></div>
      <span class="dag-demo-status"><i aria-hidden="true"></i><span data-dag-status>Mapping dependencies</span></span>
      <button type="button" data-dag-replay>Replay</button>
    </div>
    <div class="dag-demo-canvas">
      <svg viewBox="0 0 800 430" preserveAspectRatio="none" aria-hidden="true">
        <path data-dag-edge="scope:runtime" d="M180 215C205 215 215 82 240 82"/>
        <path data-dag-edge="scope:dashboard" d="M180 215H240"/>
        <path data-dag-edge="scope:docs" d="M180 215C205 215 215 348 240 348"/>
        <path data-dag-edge="runtime:integration" d="M400 82C440 82 440 142 480 142"/>
        <path data-dag-edge="dashboard:integration" d="M400 215C440 215 440 142 480 142"/>
        <path data-dag-edge="dashboard:browser" d="M400 215C440 215 440 288 480 288"/>
        <path data-dag-edge="docs:browser" d="M400 348C440 348 440 288 480 288"/>
        <path data-dag-edge="integration:release" d="M640 142C665 142 665 215 690 215"/>
        <path data-dag-edge="browser:release" d="M640 288C665 288 665 215 690 215"/>
      </svg>
      ${dagNode('scope', 'Plan', 'Map constraints', 2.5, 40)}
      ${dagNode('runtime', 'Build', 'Runtime contract', 30, 9)}
      ${dagNode('dashboard', 'Build', 'Dashboard', 30, 40)}
      ${dagNode('docs', 'Build', 'Operator docs', 30, 71)}
      ${dagNode('integration', 'Verify', 'Integration tests', 60, 23)}
      ${dagNode('browser', 'Verify', 'Browser matrix', 60, 57)}
      ${dagNode('release', 'Ship', 'Release', 86.25, 40, true)}
    </div>
  </div>`
}

function dagNode(id, phase, title, left, top, compact = false) {
  return `<div class="dag-node${compact ? ' dag-node-compact' : ''}" data-dag-node="${id}" data-state="waiting" style="left:${left}%;top:${top}%">
    <span>${escapeHtml(phase)}</span>
    <strong>${escapeHtml(title)}</strong>
    <small data-node-state>Waiting</small>
  </div>`
}

function workspaceNetworkSection() {
  return `<section class="content-section workspace-network-section">
    <div class="section-shell">
      <div class="section-heading center">
        <p class="eyebrow">One platform, isolated runtimes</p>
        <h2>One cloud. Every workspace.</h2>
        <p>Route one agent contract to laptops, servers, and compute across locations, while every tenant keeps its own sessions, workspaces, Executors, and runtime state.</p>
      </div>
      <div class="workspace-network" aria-label="Kala Agent Cloud connecting isolated tenants to workspaces across multiple machines">
        <img class="network-map" src="/assets/illustration/world-map-cc0.svg" alt="" width="2048" height="1024" loading="lazy">
        <div class="network-cloud">
          <img src="/assets/brand/kala-icon.svg" alt="" width="34" height="34">
          <strong>Kala Agent Cloud</strong>
        </div>
        <svg class="network-lines" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
          <path d="M500 66C400 80 260 96 160 118"/>
          <path d="M500 66C615 90 750 125 840 165"/>
          <path d="M500 66C525 115 550 180 570 245"/>
          <path d="M500 66C650 128 820 238 920 345"/>
          <path d="M500 66C455 135 400 225 350 290"/>
        </svg>
        ${workspacePoint('redmond', 'linux', 'Compute workspace', 'Redmond · Linux + GPU')}
        ${workspacePoint('shanghai', 'windows', 'Build cluster', 'Shanghai · Windows')}
        ${workspacePoint('nairobi', 'apple', 'Design workspace', 'Nairobi · macOS')}
        ${workspacePoint('sydney', 'windows', 'QA workspace', 'Sydney · Windows')}
        ${workspacePoint('sao-paulo', 'linux', 'Data workspace', 'São Paulo · Linux')}
      </div>
    </div>
  </section>`
}

function workspacePoint(location, system, title, detail) {
  return `<div class="workspace-point workspace-point-${location}">
    ${machineIcon(system)}
    <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>
  </div>`
}

function pageHero(eyebrow, title, lede) {
  return `<section class="page-hero"><div class="section-shell"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="page-lede">${escapeHtml(lede)}</p></div></section>`
}

function deploymentCards() {
  return `<div class="deployment-grid">
    <article class="deployment-item"><h3>Portable</h3><p>A directly managed Runtime for local and small installations.</p><a class="text-link" href="/download/">Install Portable →</a></article>
    <article class="deployment-item"><h3>Dedicated</h3><p>A complete single-tenant Platform with transactional Blue/Green Runtime deployment.</p><a class="text-link" href="/deploy/#dedicated">Understand Dedicated →</a></article>
    <article class="deployment-item"><h3>Private Cloud</h3><p>A multi-tenant Platform with isolated Runtime Units and an operator-owned trust boundary.</p><a class="text-link" href="/deploy/#private-cloud">Understand Private Cloud →</a></article>
  </div>`
}

function downloadPlatformCard(system, name, requirement, format, architectures, release, command, note) {
  return `<article class="download-platform">
    ${machineIcon(system)}
    <h2>${escapeHtml(name)}</h2>
    <p class="download-platform-requirement">${escapeHtml(requirement)}</p>
    ${commandBlock(`${system}-portable-command`, command)}
    <dl><div><dt>Manual assets</dt><dd>${architectures.map(({ label, asset }) => `<a href="${escapeAttribute(requiredAssetUrl(release, asset))}">${escapeHtml(format)} · ${escapeHtml(label)}</a>`).join('')}</dd></div></dl>
    ${note ? `<p class="download-platform-note">${escapeHtml(note)}</p>` : ''}
  </article>`
}

function requiredAssetUrl(release, name) {
  const asset = releaseAsset(release, name)
  if (!asset) throw new Error(`Published release ${release?.tag ?? 'unknown'} is missing required website asset ${name}`)
  return asset.url
}

function requirePortableManagerAssets(release) {
  for (const name of [
    'kala-portable.sh', 'kala-portable.ps1', 'SHA256SUMS.sigstore.json',
  ]) requiredAssetUrl(release, name)
}

function releaseDate(release) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(release.publishedAt))
}

function releaseStatus(release) {
  return release.prerelease ? 'Preview' : 'Stable'
}

function commandBlock(id, command) {
  return `<div class="command-block"><pre id="${escapeAttribute(id)}"><code>${escapeHtml(command)}</code></pre><button class="copy-button" type="button" data-copy-command="#${escapeAttribute(id)}">Copy</button></div>`
}

function deploymentComparison() {
  return `<div class="deployment-comparison" role="region" aria-label="Deployment mode comparison" tabindex="0">
    <table>
      <thead><tr><th scope="col">Mode</th><th scope="col">Typical scenario</th><th scope="col">Pros</th><th scope="col">Cons</th></tr></thead>
      <tbody>
        <tr><th scope="row">Portable</th><td data-label="Typical scenario">One person or a small self-hosted installation</td><td data-label="Pros">Simplest setup; supported public path; local or remote workspaces</td><td data-label="Cons">You own uptime, upgrades, and recovery</td></tr>
        <tr><th scope="row">Dedicated</th><td data-label="Typical scenario">One team that needs an always-on service</td><td data-label="Pros">Single-tenant boundary; controlled upgrades; rollback support</td><td data-label="Cons">More infrastructure; preview lifecycle</td></tr>
        <tr><th scope="row">Private Cloud</th><td data-label="Typical scenario">A platform team serving multiple tenants</td><td data-label="Pros">Tenant isolation; centralized identity and placement; operator-owned infrastructure</td><td data-label="Cons">Highest operational complexity; preview lifecycle</td></tr>
      </tbody>
    </table>
  </div>`
}

function machineIcon(kind) {
  const paths = {
    apple: '<path d="M16.7 13.2c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-1-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.8 1.3 10.3.9 1.2 1.9 2.6 3.2 2.5 1.3-.1 1.8-.8 3.4-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.8-1.1-2.8-4.1ZM14.1 5.7c.7-.9 1.2-2.1 1.1-3.2-1.1 0-2.4.7-3.2 1.6-.7.8-1.3 2-1.1 3.1 1.2.1 2.5-.6 3.2-1.5Z"/>',
    linux: '<ellipse cx="12" cy="8.5" rx="4" ry="5.5" fill="#202124"/><ellipse cx="12" cy="15" rx="6.2" ry="6.5" fill="#202124"/><circle cx="10.5" cy="7.5" r="1.35" fill="#fff"/><circle cx="13.5" cy="7.5" r="1.35" fill="#fff"/><circle cx="10.8" cy="7.7" r=".48" fill="#202124"/><circle cx="13.2" cy="7.7" r=".48" fill="#202124"/><path d="m10.2 9.3 1.8-1 1.8 1-1.8 1.3z" fill="#f4b400"/><ellipse cx="8" cy="20" rx="3.1" ry="1.35" fill="#f4b400"/><ellipse cx="16" cy="20" rx="3.1" ry="1.35" fill="#f4b400"/><ellipse cx="12" cy="15.5" rx="3.7" ry="4.6" fill="#fff"/>',
    windows: '<path d="m3 5.2 7.3-1v7H3v-6Zm8.3-1.1L21 2.8v8.4h-9.7V4.1ZM3 12.2h7.3v7L3 18.2v-6Zm8.3 0H21v8.4l-9.7-1.3v-7.1Z"/>',
  }
  return `<svg class="machine-icon machine-icon-${kind}" viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>`
}

function sideIndex(items) {
  return `<nav class="side-index" aria-label="On this page">${items.map(([id, label]) => `<a href="#${escapeAttribute(id)}">${escapeHtml(label)}</a>`).join('')}</nav>`
}

function list(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

function brandImages() {
  return `<img class="brand-image brand-image-light" src="/assets/brand/kala-wordmark.svg" alt="Kala" width="300" height="96"><img class="brand-image brand-image-dark" src="/assets/brand/kala-wordmark-dark.svg" alt="Kala" width="300" height="96">`
}

function footer() {
  return `<footer class="site-footer">
    <div class="footer-shell">
      <a class="footer-brand" href="/" aria-label="Kala home">${brandImages()}</a>
      <nav class="footer-links" aria-label="Footer navigation">
        <a href="/download/">Download</a>
        <a href="/releases/">Releases</a>
        <a href="https://github.com/kala-project/kala/tree/main/docs">Docs</a>
        <a href="https://github.com/kala-project/kala">GitHub</a>
        <a href="/security/">Security</a>
        <a href="https://github.com/kala-project/kala/blob/main/LICENSE">License</a>
      </nav>
    </div>
  </footer>`
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

function escapeAttribute(value) {
  return escapeHtml(value)
}

function applySiteBase(html, base) {
  const normalized = `/${String(base).replace(/^\/+|\/+$/g, '')}/`.replace('//', '/')
  if (normalized === '/') return html
  return html.replace(/(<a\b[^>]*\bhref=")\//g, `$1${normalized}`)
}
