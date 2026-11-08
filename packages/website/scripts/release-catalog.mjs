const repository = 'kala-project/kala'
const releasesEndpoint = `https://api.github.com/repos/${repository}/releases?per_page=100`
const releaseBaseUrl = `https://github.com/${repository}/releases`

export async function resolveReleaseCatalog({
  fallbackCatalog = [],
  releaseNotes = {},
  configuredVersion = process.env.KALA_RELEASE_VERSION,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = fetch,
} = {}) {
  let releases
  let source = 'github'

  try {
    const response = await fetchImpl(releasesEndpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'kala-website-build',
        ...(token ? { Authorization: ['Bearer', token].join(' ') } : {}),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`)
    releases = normalizeReleases(await response.json(), releaseNotes)
    if (releases.length === 0) throw new Error('GitHub Releases returned no published Kala releases')
  } catch (error) {
    releases = normalizeReleases(fallbackCatalog, releaseNotes)
    if (releases.length === 0) throw error
    source = 'fallback'
    console.warn(`Website release catalog lookup failed; using ${releases.length} local published release records.`)
  }

  const configuredTag = normalizeTag(configuredVersion)
  const stable = releases.find((release) => !release.prerelease)
  const preview = releases.find((release) => release.prerelease)
  const current = releases.find((release) => release.tag === configuredTag) ?? stable ?? releases[0]

  return { current, preview, releases, source, stable }
}

export function normalizeReleases(input, releaseNotes = {}) {
  if (!Array.isArray(input)) return []

  return input
    .map((release) => normalizeRelease(release, releaseNotes))
    .filter(Boolean)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
}

export function normalizeTag(value) {
  const normalized = String(value ?? '').trim().replace(/^v/, '')
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? `v${normalized}` : undefined
}

export function releaseAsset(release, name) {
  return release?.assets.find((asset) => asset.name === name)
}

function normalizeRelease(release, releaseNotes) {
  if (!release || release.draft === true || release.published_at === null || release.publishedAt === null) return undefined

  const tag = normalizeTag(release.tag_name ?? release.tag)
  const publishedAt = normalizeDate(release.published_at ?? release.publishedAt)
  if (!tag || !publishedAt) return undefined

  const url = normalizeReleaseUrl(release.html_url ?? release.url, tag)
  if (!url) return undefined

  const bodyNotes = parseReleaseNotes(release.body)
  const fallbackNotes = releaseNotes[tag] ?? {}
  return {
    tag,
    version: tag.slice(1),
    prerelease: release.prerelease === true,
    publishedAt,
    url,
    assets: normalizeAssets(release.assets, tag),
    previousTag: normalizeTag(fallbackNotes.previousTag),
    notes: {
      improvements: bodyNotes.improvements.length > 0 ? bodyNotes.improvements : normalizeList(fallbackNotes.improvements),
      fixes: bodyNotes.fixes.length > 0 ? bodyNotes.fixes : normalizeList(fallbackNotes.fixes),
      knownIssues: bodyNotes.knownIssues.length > 0 ? bodyNotes.knownIssues : normalizeList(fallbackNotes.knownIssues),
    },
  }
}

export async function resolveReleaseChanges(release, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  if (!release.previousTag) return undefined
  const compareUrl = `${releaseBaseUrl}/compare/${release.previousTag}...${release.tag}`
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/compare/${release.previousTag}...${release.tag}?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kala-website-build',
      ...(token ? { Authorization: ['Bearer', token].join(' ') } : {}),
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`GitHub compare returned HTTP ${response.status}`)
  const comparison = await response.json()
  const commits = comparison.commits
  if (!Number.isSafeInteger(comparison.total_commits) || !Array.isArray(commits)) {
    throw new Error(`GitHub compare returned invalid changes for ${release.tag}`)
  }
  if (commits.length !== comparison.total_commits) return { url: compareUrl, commits: [] }
  return {
    url: compareUrl,
    commits: commits.map(({ sha, commit }) => {
      if (!/^[0-9a-f]{40}$/u.test(sha) || typeof commit?.message !== 'string') {
        throw new Error(`GitHub compare returned invalid commit for ${release.tag}`)
      }
      return { sha, title: commit.message.split(/\r?\n/u)[0] }
    }),
  }
}

function normalizeAssets(input, tag) {
  if (!Array.isArray(input)) return []
  const downloadPrefix = `${releaseBaseUrl}/download/${tag}/`
  return input.flatMap((asset) => {
    const name = String(asset?.name ?? '').trim()
    const url = String(asset?.browser_download_url ?? asset?.url ?? '').trim()
    const size = Number(asset?.size)
    if (!/^[0-9A-Za-z][0-9A-Za-z._~-]*$/.test(name) || !url.startsWith(downloadPrefix)) return []
    return [{ name, url, size: Number.isSafeInteger(size) && size >= 0 ? size : undefined }]
  })
}

function normalizeReleaseUrl(value, tag) {
  const expected = `${releaseBaseUrl}/tag/${tag}`
  return String(value ?? '').trim() === expected ? expected : undefined
}

function normalizeDate(value) {
  const date = new Date(String(value ?? ''))
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : []
}

function parseReleaseNotes(body) {
  const sections = { improvements: [], fixes: [], knownIssues: [] }
  const headings = new Map([
    ['improvements', 'improvements'],
    ['fixes', 'fixes'],
    ['known issues', 'knownIssues'],
    ['known boundaries', 'knownIssues'],
  ])
  let active

  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line)
    if (heading) {
      active = headings.get(heading[1].trim().toLowerCase())
      continue
    }
    const item = /^-\s+(.+?)\s*$/u.exec(line)
    if (active && item) sections[active].push(item[1])
  }

  return sections
}
