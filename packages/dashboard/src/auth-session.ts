import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeploymentServices } from '@agent-kernel/shared'

export type AccountProfile = { displayName: string; username?: string; email?: string; initials: string }
export type AccountOrganization = { id: string; name: string; status: 'provisioning' | 'active' | 'suspended' | 'closing' | 'closed'; role: 'owner' | 'admin' | 'member' | 'viewer' }
export type AuthSession = { authenticated: true; profile: AccountProfile; organization?: AccountOrganization; deploymentServices?: DeploymentServices; cacheNamespace: string; expiresAt: string } | { authenticated: false }
export type AuthSessionState = { loading: boolean; checked: boolean; session: AuthSession | null; error: string | null; refresh(): Promise<AuthSession>; logout(): Promise<void>; announceLogout(): void }
const channelName = 'agent-runlab-auth', storageKey = 'ak-auth-event'
export async function clearAuthenticatedPwaState(): Promise<void> {
  const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> }
  await nav.clearAppBadge?.().catch(() => undefined)
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  registration?.active?.postMessage({ type: 'AUTH_LOGOUT' })
  if (typeof caches !== 'undefined') {
    const names = await caches.keys().catch(() => [])
    await Promise.all(names.filter((name) => name.startsWith('ak-')).map((name) => caches.delete(name)))
  }
}
async function fetchSession(): Promise<AuthSession> { const response = await fetch('/auth/me', { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error(`Account session request failed: ${response.status}`); return await response.json() as AuthSession }
export function useAuthSession(enabled: boolean): AuthSessionState {
  const [loading,setLoading]=useState(enabled),[checked,setChecked]=useState(false),[session,setSession]=useState<AuthSession|null>(enabled?null:{authenticated:false}),[error,setError]=useState<string|null>(null)
  const inFlight=useRef<Promise<AuthSession>|null>(null)
  const refresh=useCallback(async():Promise<AuthSession>=>{if(!enabled){const next={authenticated:false} as const;setSession(next);setChecked(false);setError(null);return next}if(inFlight.current)return inFlight.current;setLoading(true);setError(null);const task=fetchSession().then(next=>{setSession(next);setChecked(true);return next}).catch(reason=>{setChecked(true);setError(reason instanceof Error?reason.message:String(reason));throw reason}).finally(()=>{setLoading(false);inFlight.current=null});inFlight.current=task;return task},[enabled])
  useEffect(()=>{if(enabled){setSession(null);setLoading(true);setChecked(false);setError(null)}void refresh().catch(()=>undefined);if(!enabled)return;const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel(channelName):null;const markLoggedOut=()=>{setSession({authenticated:false});setChecked(true);setLoading(false)};const revalidate=(event?:MessageEvent)=>{if(event&&event.data?.type!=='logged-out'&&event.data?.type!=='session-expired')return;markLoggedOut()};const storage=(event:StorageEvent)=>{if(event.key===storageKey)markLoggedOut()};channel?.addEventListener('message',revalidate);window.addEventListener('storage',storage);const visible=()=>{if(document.visibilityState==='visible')void refresh()};document.addEventListener('visibilitychange',visible);return()=>{channel?.close();window.removeEventListener('storage',storage);document.removeEventListener('visibilitychange',visible)}},[enabled,refresh])
  const announceLogout=useCallback(()=>{const message={type:'logged-out',at:Date.now()};if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(channelName);channel.postMessage(message);channel.close()}localStorage.setItem(storageKey,JSON.stringify(message));localStorage.removeItem('ak-selected-session-id');void clearAuthenticatedPwaState()},[])
  const logout=useCallback(async()=>{const response=await fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'}});if(!response.ok&&response.status!==204)throw new Error(`Sign out failed: ${response.status}`);announceLogout()},[announceLogout])
  return {loading:enabled&&!checked?true:loading,checked,session,error,refresh,logout,announceLogout}
}
