import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import puppeteer from 'puppeteer-core'

const baseUrl = process.env.WEBSITE_URL ?? 'http://127.0.0.1:4180/'
const chromiumPath = process.env.CHROMIUM_PATH ?? [
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].find(existsSync)
if (!chromiumPath) throw new Error('No compatible Chromium or Chrome executable was found.')
const screenshotDir = process.env.WEBSITE_SCREENSHOT_DIR
let server

if (!await isReady(baseUrl)) {
  const packageRoot = resolve(import.meta.dirname, '..')
  server = spawn(resolve(packageRoot, 'node_modules/.bin/vite'), [
    'preview',
    '--config',
    'vite.config.ts',
    '--host',
    '0.0.0.0',
    '--port',
    '4180',
  ], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForReady(baseUrl, server)
}

if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: chromiumPath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars'],
})

try {
  await verifyDesktop(browser)
  await verifyMobile(browser)
  await verifyPages(browser)
} finally {
  await browser.close()
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([
      new Promise((resolveExit) => server.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ])
  }
}

async function verifyDesktop(browserInstance) {
  const page = await browserInstance.newPage()
  const failures = watchFailures(page)
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
  await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 30_000 })
  await page.waitForSelector('.hero-carousel .scene-slide.is-active .theme-picture-dark img', { visible: true })
  await loadLazyImages(page)
  const result = await page.evaluate(async () => {
    await document.fonts.ready
    const images = [...document.images].filter((image) => image.hasAttribute('src'))
    return {
      title: document.querySelector('h1')?.textContent,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      images: images.map((image) => ({ src: image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })),
      announcementBelowNavigation: (document.querySelector('.site-announcement')?.getBoundingClientRect().top ?? 0)
        >= (document.querySelector('.nav-shell')?.getBoundingClientRect().bottom ?? Number.MAX_SAFE_INTEGER),
      heroScenes: document.querySelectorAll('.hero-carousel [data-carousel-slide]').length,
      responsiveScenes: document.querySelectorAll('.responsive-carousel [data-carousel-slide]').length,
      workspaces: document.querySelectorAll('.workspace-point').length,
      featuresLink: Boolean(document.querySelector('a[href$="#features"]')),
      releasesLink: Boolean(document.querySelector('.nav-links a[href$="/releases/"]')),
      githubIcon: Boolean(document.querySelector('.nav-github svg')),
      dagNodes: document.querySelectorAll('[data-dag-node]').length,
      theme: document.documentElement.dataset.theme,
      heroControlsOutside: (() => {
        const viewport = document.querySelector('.hero-carousel .scene-viewport')?.getBoundingClientRect()
        const previous = document.querySelector('.hero-carousel [data-carousel-previous]')?.getBoundingClientRect()
        const next = document.querySelector('.hero-carousel [data-carousel-next]')?.getBoundingClientRect()
        return Boolean(viewport && previous && next && previous.right < viewport.left && next.left > viewport.right)
      })(),
      heroFrame: (() => {
        const viewport = document.querySelector('.hero-carousel .scene-viewport')
        const slide = document.querySelector('.hero-carousel .scene-slide')
        const image = document.querySelector('.hero-carousel .scene-image')
        const screenshot = document.querySelector('.hero-carousel .scene-slide.is-active img:not([style*="display: none"])')
        return {
          viewportBorder: viewport ? getComputedStyle(viewport).borderWidth : '',
          viewportShadow: viewport ? getComputedStyle(viewport).boxShadow : '',
          viewportBackground: viewport ? getComputedStyle(viewport).backgroundColor : '',
          slidePadding: slide ? getComputedStyle(slide).padding : '',
          imageBorder: image ? getComputedStyle(image).borderWidth : '',
          screenshotBorder: screenshot ? getComputedStyle(screenshot).borderWidth : '',
          screenshotRadius: screenshot ? getComputedStyle(screenshot).borderRadius : '',
        }
      })(),
    }
  })
  assert(result.title?.includes('Your') && result.title.includes('agent cloud.'), 'desktop hero title is incorrect')
  assert(result.overflow <= 1, `desktop page overflows by ${result.overflow}px`)
  assert(result.images.every((image) => image.complete && image.width > 0), `desktop contains broken images: ${JSON.stringify(result.images)}`)
  assert(result.announcementBelowNavigation, 'release announcement is not below the primary navigation')
  assert(result.heroScenes === 3 && result.responsiveScenes === 2, 'product scene carousels are incomplete')
  assert(result.workspaces === 5, 'cross-machine workspace evidence is incomplete')
  assert(result.featuresLink && result.releasesLink && result.githubIcon, 'primary product navigation is incomplete')
  assert(result.dagNodes === 7, 'DAG execution story is incomplete')
  assert(result.heroControlsOutside, 'hero carousel controls are not outside the image frame')
  assert(
    result.heroFrame.viewportBorder === '0px'
      && result.heroFrame.viewportShadow === 'none'
      && result.heroFrame.viewportBackground === 'rgba(0, 0, 0, 0)'
      && result.heroFrame.slidePadding === '0px'
      && result.heroFrame.imageBorder === '0px'
      && result.heroFrame.screenshotBorder === '0px'
      && result.heroFrame.screenshotRadius === '12px',
    `hero carousel still has an outer frame: ${JSON.stringify(result.heroFrame)}`,
  )
  const heroImage = result.images.find((image) => image.src.includes('hero-workbench.webp'))
  assert(heroImage?.width === 1440 && heroImage.height === 900, `hero evidence is not 16:10: ${JSON.stringify(heroImage)}`)
  assert(result.theme === 'dark', `unexpected initial color theme: ${result.theme}`)
  assert(failures.length === 0, failures.join('\n'))
  await page.click('[data-dismiss-announcement]')
  assert(await page.evaluate(() => document.documentElement.dataset.releaseNotice === 'hidden'), 'release announcement was not dismissed')
  await page.click('[data-dag-replay]')
  assert(await page.$eval('[data-dag-node="scope"]', (node) => node.getAttribute('data-state') === 'running'), 'DAG replay did not restart execution')
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 9_700))
  assert(await page.$eval('[data-dag-status]', (node) => node.textContent === 'Plan complete'), 'DAG animation did not reach its completed state')
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_300))
  assert(await page.$eval('[data-dag-node="scope"]', (node) => node.getAttribute('data-state') === 'running'), 'DAG animation did not replay after its completion pause')
  const heroIndex = await page.$eval('.hero-carousel', (node) => Number(node.getAttribute('data-carousel-index') ?? 0))
  await page.click('.hero-carousel [data-carousel-next]')
  assert(
    await page.$eval('.hero-carousel', (node, expected) => Number(node.getAttribute('data-carousel-index') ?? 0) === expected, (heroIndex + 1) % 3),
    'hero carousel did not advance',
  )
  const darkThemeState = await page.evaluate(() => {
    const map = document.querySelector('.network-map')
    const apple = document.querySelector('.machine-icon-apple')
    const skip = document.querySelector('.skip-link')
    const feature = document.querySelector('.feature-visual')
    const responsive = document.querySelector('.responsive-carousel .scene-viewport')
    return {
      mapOpacity: map ? Number.parseFloat(getComputedStyle(map).opacity) : 0,
      appleColor: apple ? getComputedStyle(apple).color : '',
      skipBackground: skip ? getComputedStyle(skip).backgroundColor : '',
      featureBackground: feature ? getComputedStyle(feature).backgroundColor : '',
      featureBorderWidth: feature ? getComputedStyle(feature).borderTopWidth : '',
      featurePadding: feature ? getComputedStyle(feature).paddingTop : '',
      featureShadow: feature ? getComputedStyle(feature).boxShadow : '',
      responsiveBackground: responsive ? getComputedStyle(responsive).backgroundColor : '',
      responsiveBorderWidth: responsive ? getComputedStyle(responsive).borderTopWidth : '',
      responsiveShadow: responsive ? getComputedStyle(responsive).boxShadow : '',
    }
  })
  assert(darkThemeState.mapOpacity >= 0.18, `dark map contrast is too low: ${darkThemeState.mapOpacity}`)
  assert(darkThemeState.appleColor === 'rgb(245, 248, 252)', `dark Apple icon is not visible: ${darkThemeState.appleColor}`)
  assert(darkThemeState.skipBackground === 'rgb(133, 197, 255)', `dark skip link contrast is invalid: ${darkThemeState.skipBackground}`)
  assert(darkThemeState.featureBackground === 'rgba(0, 0, 0, 0)', `dark feature image has an extra background: ${darkThemeState.featureBackground}`)
  assert(darkThemeState.featureBorderWidth === '0px', `dark feature image has an extra border: ${darkThemeState.featureBorderWidth}`)
  assert(darkThemeState.featurePadding === '0px', `dark feature image has extra frame padding: ${darkThemeState.featurePadding}`)
  assert(darkThemeState.featureShadow === 'none', `dark feature image has an extra shadow: ${darkThemeState.featureShadow}`)
  assert(darkThemeState.responsiveBackground === 'rgba(0, 0, 0, 0)', `dark responsive image has an extra background: ${darkThemeState.responsiveBackground}`)
  assert(darkThemeState.responsiveBorderWidth === '0px', `dark responsive image has an extra border: ${darkThemeState.responsiveBorderWidth}`)
  assert(darkThemeState.responsiveShadow === 'none', `dark responsive image has an extra shadow: ${darkThemeState.responsiveShadow}`)
  const darkProductImage = await page.$eval('.hero-carousel .scene-slide.is-active', (slide) => {
    const images = [...slide.querySelectorAll('img')]
    return images.find((image) => image.getClientRects().length > 0)?.currentSrc ?? ''
  })
  assert(darkProductImage.includes('-dark.webp'), `dark theme product image did not switch: ${darkProductImage}`)
  await page.$eval('.hero-carousel .scene-slide.is-active [data-lightbox-src]', (node) => {
    if (node instanceof HTMLButtonElement) node.click()
  })
  await page.waitForSelector('[data-image-lightbox][open]', { visible: true })
  assert(
    await page.$eval('[data-lightbox-image]', (image) => image.getAttribute('src')?.includes('-dark.webp')),
    'dark theme lightbox did not use the dark product image',
  )
  await page.click('[data-lightbox-close]')
  await page.click('[data-theme-toggle]')
  assert(await page.evaluate(() => document.documentElement.dataset.theme === 'light'), 'theme control did not restore light mode')
  assert(
    await page.$eval('.hero-carousel .scene-slide.is-active img', (image) => getComputedStyle(image).borderWidth === '1px'),
    'light theme product image is missing its subtle border',
  )
  await page.$eval('.hero-carousel .scene-slide.is-active [data-lightbox-src]', (node) => {
    if (node instanceof HTMLButtonElement) node.click()
  })
  await page.waitForSelector('[data-image-lightbox][open]', { visible: true })
  const lightboxState = await page.$eval('[data-image-lightbox]', (dialog) => ({
    open: dialog.hasAttribute('open'),
    width: dialog.querySelector('img')?.getBoundingClientRect().width ?? 0,
  }))
  assert(lightboxState.open && lightboxState.width > 600, `image lightbox is invalid: ${JSON.stringify(lightboxState)}`)
  await page.click('[data-lightbox-close]')
  await activateCarouselScene(page, '.responsive-carousel', 0)
  const devicePair = await page.$$eval('.responsive-device-pair .device-mockup', (devices) => devices.map((device) => {
    const rect = device.getBoundingClientRect()
    return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }
  }))
  assert(
    devicePair.length === 2
      && devicePair[0].height > 220
      && devicePair[1].width > 220
      && devicePair[0].right <= devicePair[1].left,
    `phone and tablet frames are invalid: ${JSON.stringify(devicePair)}`,
  )
  await activateCarouselScene(page, '.responsive-carousel', 1)
  assert(await page.$eval('.responsive-carousel', (node) => node.getAttribute('data-carousel-index') === '1'), 'desktop device scene did not activate')
  if (screenshotDir) {
    const deviceFrame = await page.$('.responsive-carousel .scene-viewport')
    if (!deviceFrame) throw new Error('responsive device frame is missing')
    for (const [index, name] of [[0, 'phone-tablet'], [1, 'laptop']]) {
      await activateCarouselScene(page, '.responsive-carousel', index)
      await deviceFrame.screenshot({ path: join(screenshotDir, `website-${name}-frame.png`) })
    }
    await page.screenshot({ path: join(screenshotDir, 'website-desktop.png'), fullPage: true })
  }
  await page.close()
}

async function verifyMobile(browserInstance) {
  const page = await browserInstance.newPage()
  const failures = watchFailures(page)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 30_000 })
  await page.click('[data-menu-button]')
  await page.waitForSelector('[data-site-navigation][data-open]', { visible: true })
  const result = await page.evaluate(async () => {
    await document.fonts.ready
    const menu = document.querySelector('[data-site-navigation]')
    const firstImage = document.querySelector('.hero-carousel .scene-image img')
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      menuVisible: menu instanceof HTMLElement && getComputedStyle(menu).display !== 'none',
      downloadVisible: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('Download') && link.getBoundingClientRect().width > 0),
      imageWidth: firstImage instanceof HTMLImageElement ? firstImage.getBoundingClientRect().width : 0,
      imageHeight: firstImage instanceof HTMLImageElement ? firstImage.getBoundingClientRect().height : 0,
    }
  })
  assert(result.overflow <= 1, `mobile page overflows by ${result.overflow}px`)
  assert(result.menuVisible && result.downloadVisible, 'mobile navigation is not usable')
  assert(
    result.imageWidth > 230 && result.imageWidth <= 390 && result.imageHeight >= 500,
    `mobile hero evidence is not legible: ${result.imageWidth}x${result.imageHeight}`,
  )
  assert(failures.length === 0, failures.join('\n'))
  await page.click('[data-menu-button]')
  await activateCarouselScene(page, '.responsive-carousel', 1)
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'website-mobile.png'), fullPage: true })
  await page.close()
}

async function verifyPages(browserInstance) {
  for (const path of ['download/', 'deploy/', 'security/', 'releases/']) {
    const page = await browserInstance.newPage()
    const failures = watchFailures(page)
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
    const response = await page.goto(new URL(path, baseUrl).href, { waitUntil: 'networkidle0', timeout: 30_000 })
    assert(response?.ok(), `${path} did not return success`)
    const state = await page.evaluate(() => ({
      h1: document.querySelector('h1')?.textContent,
      main: Boolean(document.querySelector('main')),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      downloadCards: document.querySelectorAll('.download-platform').length,
      downloadCommands: document.querySelectorAll('.download-platform .command-block').length,
      windowsVerifiedInstall: ['Invoke-WebRequest', 'cosign verify-blob', 'Get-FileHash', 'kala-portable.ps1 install', 'kala-portable.ps1 start']
        .every((step) => document.querySelector('#windows-portable-command')?.textContent?.includes(step)),
      downloadModes: document.querySelectorAll('[data-download-mode]').length,
      releaseHighlights: document.querySelectorAll('.release-highlights li').length,
      releaseTocLinks: document.querySelectorAll('.release-on-this-page a').length,
      releaseArchiveLinks: document.querySelectorAll('.release-archive nav a').length,
      releaseChanges: document.querySelectorAll('#changes a[href*="/compare/"], #previous-changes a[href*="/compare/"]').length,
      priorRelease: Boolean(document.querySelector('#previous-release')),
      releaseOnPageVisible: document.querySelector('.release-on-this-page')?.getBoundingClientRect().width ?? 0,
    }))
    assert(state.h1 && state.main, `${path} lacks semantic page content`)
    assert(state.overflow <= 1, `${path} overflows by ${state.overflow}px`)
    if (path === 'download/') {
      assert(
        state.downloadCards === 3 && state.downloadCommands === 3 && state.windowsVerifiedInstall && state.downloadModes === 3,
        'download platform or deployment mode support is unclear',
      )
      for (const mode of ['dedicated', 'private-cloud', 'portable']) {
        await page.click(`[data-download-mode="${mode}"]`)
        const visible = await page.evaluate(
          (selectedMode) => !document.querySelector(`[data-download-panel="${selectedMode}"]`)?.hidden,
          mode,
        )
        assert(visible, `${mode} download mode did not open`)
      }
    }
    if (path === 'releases/') {
      assert(
        state.releaseHighlights === 2
          && state.releaseTocLinks === 7
          && state.releaseArchiveLinks >= 4
          && state.releaseChanges === 2
          && state.priorRelease
          && state.releaseOnPageVisible > 0,
        'release notes structure is incomplete',
      )
    }
    assert(failures.length === 0, failures.join('\n'))
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `website-${path.slice(0, -1)}.png`), fullPage: true })
    if (path === 'download/' || path === 'releases/') {
      const darkState = await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
        const appleIcon = document.querySelector('.download-platform .machine-icon-apple')
        const command = document.querySelector('.download-platform .command-block pre')
        return {
          appleColor: appleIcon ? getComputedStyle(appleIcon).color : null,
          canvas: getComputedStyle(document.body).backgroundColor,
          commandWidth: command?.getBoundingClientRect().width ?? 0,
          commandLength: command?.textContent?.trim().length ?? 0,
        }
      })
      assert(darkState.canvas !== 'rgb(247, 249, 252)', `${path} did not enter dark mode`)
      if (path === 'download/') {
        assert(darkState.appleColor === 'rgb(245, 248, 252)', 'download macOS icon is not visible in dark mode')
        assert(darkState.commandWidth > 200 && darkState.commandLength > 80, 'download command is not legible in dark mode')
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      if (screenshotDir) {
        await page.screenshot({ path: join(screenshotDir, `website-${path.slice(0, -1)}-dark.png`), fullPage: true })
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert(mobileOverflow <= 1, `${path} mobile layout overflows by ${mobileOverflow}px`)
    if (screenshotDir && (path === 'download/' || path === 'releases/')) {
      await page.screenshot({ path: join(screenshotDir, `website-${path.slice(0, -1)}-mobile.png`), fullPage: true })
    }
    await page.close()
  }
}

function watchFailures(page) {
  const failures = []
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`))
  return failures
}

async function activateCarouselScene(page, selector, targetIndex) {
  await page.$eval(selector, (carousel, index) => {
    const total = carousel.querySelectorAll('[data-carousel-slide]').length
    const current = Number(carousel.getAttribute('data-carousel-index') ?? 0)
    const steps = (Number(index) - current + total) % total
    const next = carousel.querySelector('[data-carousel-next]')
    for (let step = 0; step < steps; step += 1) {
      if (next instanceof HTMLButtonElement) next.click()
    }
  }, targetIndex)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 650))
}

async function loadLazyImages(page) {
  await page.evaluate(async () => {
    for (const image of document.images) image.loading = 'eager'
    for (const image of document.images) {
      image.scrollIntoView({ block: 'center' })
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
    }
    await Promise.all([...document.images].map((image) => {
      if (image.complete) return undefined
      return new Promise((resolveImage) => {
        image.addEventListener('load', resolveImage, { once: true })
        image.addEventListener('error', resolveImage, { once: true })
      })
    }))
    window.scrollTo(0, 0)
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function isReady(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

async function waitForReady(url, child) {
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk).slice(-4_000) })
  child.stderr.on('data', (chunk) => { output += String(chunk).slice(-4_000) })
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`website preview exited with ${child.exitCode}\n${output}`)
    if (await isReady(url)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`website preview did not become ready\n${output}`)
}
