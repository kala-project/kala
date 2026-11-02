import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@agent-kernel/shared'

export type SessionTabState = { open: string[]; pinned: string[]; closed: string[]; history: string[]; historyIndex: number }
const KEY='ak-session-tabs-v1'
const empty:SessionTabState={open:[],pinned:[],closed:[],history:[],historyIndex:-1}
export function useSessionTabs(sessions:readonly SessionSummary[],active:string|null,onSelect:(id:string)=>void){
 const [state,setState]=useState<SessionTabState>(()=>{try{return {...empty,...JSON.parse(localStorage.getItem(KEY)??'{}')}}catch{return empty}})
 const stateRef=useRef(state);stateRef.current=state
 useEffect(()=>{localStorage.setItem(KEY,JSON.stringify(state))},[state])
 useEffect(()=>{void fetch('/user/session-tabs',{cache:'no-store'}).then(r=>r.ok?r.json():null).then((doc:{content?:string}|null)=>{if(!doc?.content)return;const remote=JSON.parse(doc.content) as Pick<SessionTabState,'pinned'|'open'>;setState(s=>({...s,pinned:remote.pinned??s.pinned,open:remote.open??s.open}))}).catch(()=>undefined)},[])
 useEffect(()=>{const timer=setTimeout(()=>{void fetch('/user/session-tabs',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:JSON.stringify({pinned:state.pinned,open:state.open})})}).catch(()=>undefined)},700);return()=>clearTimeout(timer)},[state.pinned,state.open])
 useEffect(()=>{const ids=new Set(sessions.map(s=>s.sessionId));setState(s=>{
  const open=s.open.filter(id=>ids.has(id));const pinned=s.pinned.filter(id=>ids.has(id))
  return open.length===s.open.length&&pinned.length===s.pinned.length?s:{...s,open,pinned}
 })},[sessions])
 const open=useCallback((id:string)=>setState(s=>{const list=s.open.includes(id)?s.open:[...s.open,id];const history=s.history[s.historyIndex]===id?s.history:[...s.history.slice(0,s.historyIndex+1),id];return {...s,open:list,history:history.slice(-100),historyIndex:Math.min(history.length-1,99)}}),[])
 useEffect(()=>{if(active)open(active)},[active,open])
 const close=useCallback((id:string)=>setState(s=>{const open=s.open.filter(x=>x!==id);const closed=[id,...s.closed.filter(x=>x!==id)].slice(0,20);if(active===id){const next=open[Math.min(s.open.indexOf(id),open.length-1)];if(next)queueMicrotask(()=>onSelect(next))}return {...s,open,closed,pinned:s.pinned.filter(x=>x!==id)}}),[active,onSelect])
 const restore=useCallback(()=>setState(s=>{const id=s.closed[0];if(!id)return s;queueMicrotask(()=>onSelect(id));return {...s,open:s.open.includes(id)?s.open:[...s.open,id],closed:s.closed.slice(1)}}),[onSelect])
 const pin=useCallback((id:string)=>setState(s=>({...s,pinned:s.pinned.includes(id)?s.pinned.filter(x=>x!==id):[...s.pinned,id]})),[])
 const reorder=useCallback((from:string,to:string)=>setState(s=>{const next=s.open.filter(x=>x!==from);const at=Math.max(0,next.indexOf(to));next.splice(at,0,from);return {...s,open:next}}),[])
 const navigate=useCallback((delta:number)=>{const s=stateRef.current;const next=Math.max(0,Math.min(s.history.length-1,s.historyIndex+delta));const id=s.history[next];if(id){setState(x=>({...x,historyIndex:next}));onSelect(id)}},[onSelect])
 return {state,open,close,restore,pin,reorder,navigate}
}
