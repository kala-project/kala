import type { DesktopNotificationKind, PushDevice } from '@agent-kernel/shared/push'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../../components/ui/help-hint.js'
import { isDesktopClient } from '../../../lib/desktop.js'
import { useDesktopBridge } from '../../../lib/desktop-bridge.js'

import { appBadgeSupported } from '../../../lib/app-badge.js'
import {
  DESKTOP_NOTIFICATION_PREFS,
  PREF_DESKTOP_NOTIFICATIONS_ENABLED,
  PREF_DESKTOP_NOTIFICATION_SOUND,
  notificationPermission,
  requestNotificationPermission,
} from '../../../lib/desktop-notifications.js'
import {
  currentPushEndpoint,
  detectPushSupport,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupport,
} from '../../../lib/push.js'
import { DASHBOARD_PREFERENCES, PREF_APP_BADGE_ENABLED, useBooleanPref } from '../../../lib/prefs.js'
import { pushDeviceId } from '../../../lib/push-activity.js'
import { InterfaceToggle, SectionHeader, Toggle } from '../controls.js'

export function NotificationsSection(): JSX.Element {
  const { t } = useTranslation()
  const [appBadgeEnabled, setAppBadgeEnabled] = useBooleanPref(PREF_APP_BADGE_ENABLED, true)
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.notifications.label')}
        subtitle={t('settings.notifications.subtitle')}
      />
      <ul className="space-y-3 text-sm">
        {isDesktopClient() ? <NativeNotificationsSettings /> : <SystemNotificationsSettings />}
        {!isDesktopClient() ? <InterfaceToggle
          label={t('settings.notifications.appBadge')}
          description={appBadgeSupported() ? t('settings.notifications.appBadgeAvailable') : t('settings.notifications.appBadgeUnavailable')}
          checked={appBadgeEnabled && appBadgeSupported()}
          onChange={setAppBadgeEnabled}
          testId="settings-toggle-app-badge"
          disabled={!appBadgeSupported()}
        /> : null}
      </ul>
    </div>
  )
}

function NativeNotificationsSettings(): JSX.Element {
  const { t } = useTranslation()
  const native = useDesktopBridge()
  const [enabled, setEnabled] = useBooleanPref(PREF_DESKTOP_NOTIFICATIONS_ENABLED, false)
  const [details, setDetails] = useBooleanPref(DASHBOARD_PREFERENCES.desktopNotificationDetails.key, false)
  const available = Boolean(native.bridge && native.info && native.info.notificationsAvailable !== false && !native.error)
  return (
    <li className="space-y-4 rounded-lg border border-border/50 bg-card/60 p-4" data-testid="settings-native-notifications">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 font-medium">{t('settings.notifications.system')}<HelpHint label={t('settings.notifications.system')}>{t('desktopNative.notificationHelp')}</HelpHint></div>
        <Toggle checked={enabled && available} onChange={setEnabled} ariaLabel={t('settings.notifications.enable')} testId="settings-toggle-desktop-notifications" disabled={!available} />
      </div>
      {!available ? <p role="status" className="text-xs text-muted-foreground">{t(native.bridge && !native.info && !native.error ? 'desktopNative.connecting' : 'desktopNative.notificationsUnavailable')}</p> : null}
      {native.error ? <p role="alert" className="text-xs text-destructive">{t('desktopNative.failure', { detail: native.error })}</p> : null}
      <div className="grid gap-2">
        {DESKTOP_NOTIFICATION_PREFS.map((pref) => <NotificationKindToggle key={pref.key} prefKey={pref.key} label={t(`settings.notifications.prefs.${notificationKindKey(pref.kind)}.label`)} disabled={!enabled || !available} />)}
        <NotificationKindToggle prefKey={PREF_DESKTOP_NOTIFICATION_SOUND} label={t('settings.interface.sound')} disabled={!enabled || !available} />
      </div>
      <ul><InterfaceToggle label={t('desktopNative.details')} description={t('desktopNative.detailsHelp')} checked={details} onChange={setDetails} testId="settings-native-notification-details" disabled={!enabled || !available} /></ul>
    </li>
  )
}

function SystemNotificationsSettings(): JSX.Element {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useBooleanPref(PREF_DESKTOP_NOTIFICATIONS_ENABLED, false)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => notificationPermission())
  const [support] = useState<PushSupport>(() => detectPushSupport())
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [devices, setDevices] = useState<PushDevice[]>([])
  const currentDeviceId = pushDeviceId()

  const refreshDevices = async (): Promise<void> => {
    try {
      const res = await fetch(`/push/devices?currentDeviceId=${encodeURIComponent(currentDeviceId)}`, { credentials: 'same-origin', cache: 'no-store' })
      if (res.ok) setDevices(((await res.json()) as { devices?: PushDevice[] }).devices ?? [])
    } catch {}
  }

  useEffect(() => {
    let cancelled = false
    void currentPushEndpoint().then((value) => {
      if (!cancelled) setEndpoint(value)
    })
    void refreshDevices()
    return () => { cancelled = true }
  }, [])

  const syncBackgroundDelivery = async (): Promise<void> => {
    if (!support.supported || permission !== 'granted') return
    const result = await subscribeToPush(collectEnabledKinds())
    if (result.ok) setEndpoint(result.endpoint)
  }

  const setSystemNotifications = async (next: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!next) {
        setEnabled(false)
        await unsubscribeFromPush()
        setEndpoint(null)
        return
      }
      let current = notificationPermission()
      if (current === 'default') current = await requestNotificationPermission()
      setPermission(current)
      if (current !== 'granted') {
        setEnabled(false)
        return
      }
      setEnabled(true)
      if (support.supported) {
        const result = await subscribeToPush(collectEnabledKinds())
        if (result.ok) setEndpoint(result.endpoint)
        else setError(backgroundDeliveryFailure(result.reason, t))
      }
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async (): Promise<void> => {
    setBusy(true)
    setTestResult(null)
    setError(null)
    try {
      const res = await fetch('/push/test', { method: 'POST', credentials: 'same-origin' })
      if (!res.ok) setTestResult(t('settings.notifications.testFailed'))
      else {
        const body = (await res.json()) as { delivered?: number }
        setTestResult((body.delivered ?? 0) > 0 ? t('settings.notifications.testSent') : t('settings.notifications.testNone'))
      }
    } catch {
      setTestResult(t('settings.notifications.testFailed'))
    } finally {
      setBusy(false)
    }
  }

  const unavailable = permission === 'denied' || permission === 'unsupported'
  const active = enabled && permission === 'granted'
  return (
    <li className="rounded-lg border border-border/50 bg-card/60 p-4" data-testid="settings-push-section">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1 font-medium">{t('settings.notifications.system')}<HelpHint label={t('settings.notifications.system')}>{t('settings.notifications.systemDescription')}</HelpHint></div>
          <p className="mt-1 text-caption text-muted-foreground" data-testid="desktop-notification-permission">
            {active
              ? endpoint ? t('settings.notifications.enabledDevice') : t('settings.notifications.enabledBrowser')
              : t('settings.notifications.permission', { value: permissionLabel(permission, t) })}
          </p>
        </div>
        <Toggle
          checked={active}
          onChange={(next) => { void setSystemNotifications(next) }}
          ariaLabel={t('settings.notifications.enable')}
          testId="settings-toggle-desktop-notifications"
          disabled={busy || unavailable}
        />
      </div>

      {unavailable ? (
        <div className="mt-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {permission === 'unsupported'
            ? t('settings.interface.notificationUnsupported')
            : t('settings.interface.notificationBlocked')}
        </div>
      ) : null}

      <div className="mt-4 border-t border-border/60 pt-4">
        <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.notifications.kinds')}<HelpHint label={t('settings.notifications.kinds')}>{DESKTOP_NOTIFICATION_PREFS.map((pref) => <span className="mb-2 block last:mb-0" key={pref.kind}><strong>{t(`settings.notifications.prefs.${notificationKindKey(pref.kind)}.label`)}</strong><br />{t(`settings.notifications.prefs.${notificationKindKey(pref.kind)}.description`)}</span>)}</HelpHint></div>
        <div className="grid gap-2">
          {DESKTOP_NOTIFICATION_PREFS.map((pref) => (
            <NotificationKindToggle
              key={pref.kind}
              prefKey={pref.key}
              label={t(`settings.notifications.prefs.${notificationKindKey(pref.kind)}.label`)}
              disabled={!active}
              onChanged={() => { void syncBackgroundDelivery() }}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-4">
        <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.notifications.devices')}<HelpHint label={t('settings.notifications.devices')}>{t('settings.notifications.devicesDescription')}</HelpHint></div>
        <div className="grid gap-2" data-testid="settings-notification-devices">
          {devices.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/50 px-3 py-4 text-xs text-muted-foreground">{t('settings.notifications.noDevices')}</div>
          ) : devices.map((device) => (
            <NotificationDeviceRow key={device.deviceId} device={device} busy={busy} onRefresh={refreshDevices} onTestResult={setTestResult} />
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.notifications.thisDevice')}</div>
        <NotificationKindToggle
          prefKey={PREF_DESKTOP_NOTIFICATION_SOUND}
          label={t('settings.interface.sound')}
          description={t('settings.notifications.soundDescription')}
          disabled={!active}
        />
        {endpoint ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="settings-push-test"
              onClick={() => { void sendTest() }}
              disabled={busy}
              className="rounded-md border border-border/50 bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('settings.notifications.sendTest')}
            </button>
            {testResult ? <span className="text-xs text-muted-foreground">{testResult}</span> : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {error}
        </div>
      ) : null}
    </li>
  )
}

function NotificationDeviceRow({ device, busy, onRefresh, onTestResult }: {
  device: PushDevice
  busy: boolean
  onRefresh(): Promise<void>
  onTestResult(value: string): void
}): JSX.Element {
  const { t } = useTranslation()
  const update = async (enabled: boolean): Promise<void> => {
    await fetch('/push/device', {
      method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId, enabled }),
    })
    await onRefresh()
  }
  const remove = async (): Promise<void> => {
    await fetch('/push/device', {
      method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId }),
    })
    await onRefresh()
  }
  const test = async (): Promise<void> => {
    const res = await fetch('/push/test', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId }),
    })
    const body = res.ok ? await res.json() as { delivered?: number } : null
    onTestResult((body?.delivered ?? 0) > 0 ? t('settings.notifications.testDeviceSent', { name: device.name }) : t('settings.notifications.testDeviceFailed', { name: device.name }))
  }
  return (
    <div className="rounded-md bg-muted/30 p-3" data-testid={`settings-notification-device-${device.deviceId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">{device.name}{device.current ? ` · ${t('settings.notifications.currentDevice')}` : ''}</div>
          <div className="mt-0.5 text-caption text-muted-foreground">{t('settings.notifications.lastRegistered', { value: new Date(device.lastSeenAt).toLocaleString() })}</div>
        </div>
        <Toggle checked={device.enabled} onChange={(next) => { void update(next) }} ariaLabel={t('settings.notifications.deviceAria', { name: device.name })} disabled={busy} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => { void test() }} disabled={busy || !device.enabled} className="rounded border border-border/50 px-2 py-1 text-caption hover:bg-muted disabled:opacity-50">{t('settings.notifications.sendTestShort')}</button>
        {!device.current ? <button type="button" onClick={() => { void remove() }} disabled={busy} className="rounded border border-border/50 px-2 py-1 text-caption text-muted-foreground hover:bg-muted disabled:opacity-50">{t('settings.notifications.remove')}</button> : null}
      </div>
    </div>
  )
}

function NotificationKindToggle({
  prefKey,
  label,
  description,
  disabled,
  onChanged,
}: {
  prefKey: string
  label: string
  description?: string
  disabled: boolean
  onChanged?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [checked, setChecked] = useBooleanPref(prefKey, true)
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-xs font-medium text-foreground">{label}{description ? <HelpHint label={label}>{description}</HelpHint> : null}</div>
      </div>
      <Toggle
        checked={checked}
        onChange={(next) => {
          setChecked(next)
          queueMicrotask(() => onChanged?.())
        }}
        ariaLabel={t('settings.interface.notify', { label })}
        testId={`settings-toggle-notification-${prefKey}`}
        disabled={disabled}
      />
    </div>
  )
}

function collectEnabledKinds(): readonly DesktopNotificationKind[] {
  const kinds: DesktopNotificationKind[] = []
  for (const pref of DESKTOP_NOTIFICATION_PREFS) {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(pref.key)
    const enabled = raw === null || (raw !== '0' && raw !== 'false')
    if (enabled) kinds.push(pref.kind as DesktopNotificationKind)
  }
  return kinds
}

function backgroundDeliveryFailure(reason: 'permission_denied' | 'no_vapid' | 'subscribe_failed' | 'server_rejected', t: ReturnType<typeof useTranslation>['t']): string {
  switch (reason) {
    case 'permission_denied': return t('settings.notifications.errors.permissionDenied')
    case 'no_vapid': return t('settings.notifications.errors.noVapid')
    case 'subscribe_failed': return t('settings.notifications.errors.subscribeFailed')
    case 'server_rejected': return t('settings.notifications.errors.serverRejected')
  }
}

function notificationKindKey(kind: DesktopNotificationKind): 'approval' | 'waiting' | 'error' | 'connection' | 'workspace' {
  if (kind === 'approval_required') return 'approval'
  if (kind === 'waiting_for_user') return 'waiting'
  if (kind === 'session_error') return 'error'
  if (kind === 'connection_lost') return 'connection'
  return 'workspace'
}

function permissionLabel(permission: NotificationPermission | 'unsupported', t: ReturnType<typeof useTranslation>['t']): string {
  if (permission === 'default') return t('settings.interface.permissionDefault')
  if (permission === 'unsupported') return t('settings.interface.permissionUnsupported')
  return permission
}
