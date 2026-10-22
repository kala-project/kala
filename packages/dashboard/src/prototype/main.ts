import './session-card-mock.css'

localStorage.setItem('ak-explorer-open', 'true')
localStorage.setItem('ak-inspector-open', 'true')
localStorage.setItem('ak-auto-hide-offline-workspaces', 'false')
localStorage.setItem('ak-hide-sub-agent-sessions', 'false')

const url = new URL(window.location.href)
const typography = url.searchParams.get('typography')
document.documentElement.dataset.sidebarTypography = typography === 'noto' || typography === 'lato' ? typography : 'inter'
if (!url.searchParams.has('sessionId')) {
  url.searchParams.set('sessionId', url.searchParams.get('preview') === 'workstream' ? 'prototype-workstream' : 'prototype-active')
  window.history.replaceState(null, '', url)
}

if (url.searchParams.get('preview') === 'scheduled-tasks') {
  void import('./scheduled-tasks-preview.js')
} else {
  void import('../main.js')
}
