import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPicker } from './DirectoryPicker.js'

describe('DirectoryPicker Windows paths',()=>{
  afterEach(()=>localStorage.removeItem('ak-show-hidden-files'))
  it('shows dotfiles only when requested, without reloading the directory', async()=>{
    const root='/workspace'
    const listeners=new Map<string,(value:any)=>void>()
    const emit=vi.fn((event:string,payload:any)=>{
      if(event==='client:list_dirs')queueMicrotask(()=>listeners.get('server:dir_list')?.({
        requestId:payload.requestId,workspaceId:'ws',path:root,roots:[root],
        entries:[{name:'project',path:`${root}/project`,type:'directory'},{name:'.config',path:`${root}/.config`,type:'directory'},{name:'.env',path:`${root}/.env`,type:'file'}],
      }))
    })
    const socket={emit,on:(event:string,fn:(value:any)=>void)=>listeners.set(event,fn),off:vi.fn()} as any
    function Harness(){const [value,setValue]=useState(root);return <DirectoryPicker socket={socket} workspaceId="ws" initialPath={root} value={value} onChange={setValue}/>}
    render(<Harness/>)
    expect(await screen.findByText('project')).toBeTruthy()
    expect(screen.queryByText('.config')).toBeNull()
    fireEvent.click(screen.getByTestId('dir-picker-hidden-toggle'))
    expect(screen.getByText('.config')).toBeTruthy()
    expect(screen.getByText('.env')).toBeTruthy()
    expect(emit).toHaveBeenCalledTimes(1)
  })
  it('loads drive-letter roots and accepts typed child paths',async()=>{
    const root='C:\\Users\\admin'
    const child=`${root}\\project`
    const listeners=new Map<string,(value:any)=>void>()
    const emit=vi.fn((event:string,payload:any)=>{if(event==='client:list_dirs')queueMicrotask(()=>listeners.get('server:dir_list')?.({requestId:payload.requestId,workspaceId:'ws',path:payload.path??root,roots:[root],entries:[]}))})
    const socket={emit,on:(event:string,fn:(value:any)=>void)=>listeners.set(event,fn),off:vi.fn()} as any
    function Harness(){const [value,setValue]=useState(root);return <DirectoryPicker socket={socket} workspaceId="ws" initialPath={root} value={value} onChange={setValue}/>}
    render(<Harness/>)
    await waitFor(()=>expect(emit).toHaveBeenCalledWith('client:list_dirs',expect.objectContaining({path:root}),expect.any(Function)))
    const input=screen.getByDisplayValue(root)
    fireEvent.change(input,{target:{value:child}})
    fireEvent.keyDown(input,{key:'Enter'})
    expect(emit).toHaveBeenCalledWith('client:list_dirs',expect.objectContaining({path:child}),expect.any(Function))
  })

  it('reloads the selected path after the Dashboard socket reconnects',async()=>{
    const root='/workspace'
    const listeners=new Map<string,(value:any)=>void>()
    const emit=vi.fn((event:string,payload:any)=>{
      if(event==='client:list_dirs')queueMicrotask(()=>listeners.get('server:dir_list')?.({
        requestId:payload.requestId,
        workspaceId:'ws',
        path:payload.path??root,
        roots:[root],
        entries:[],
      }))
    })
    const socket={emit,on:(event:string,fn:(value:any)=>void)=>listeners.set(event,fn),off:vi.fn()} as any
    function Harness(){const [value,setValue]=useState(root);return <DirectoryPicker socket={socket} workspaceId="ws" initialPath={root} value={value} onChange={setValue}/>}
    render(<Harness/>)
    await waitFor(()=>expect(emit).toHaveBeenCalledTimes(1))

    listeners.get('connect')?.(undefined)

    await waitFor(()=>expect(emit).toHaveBeenCalledTimes(2))
    expect(emit).toHaveBeenLastCalledWith('client:list_dirs',expect.objectContaining({path:root}),expect.any(Function))
  })

  it('creates a child folder and opens it',async()=>{
    const root='/workspace'
    const child=`${root}/created`
    const listeners=new Map<string,(value:any)=>void>()
    const emit=vi.fn((event:string,payload:any,ack?:Function)=>{
      if(event==='client:list_dirs')queueMicrotask(()=>listeners.get('server:dir_list')?.({
        requestId:payload.requestId,
        workspaceId:'ws',
        path:payload.path??root,
        roots:[root],
        entries:[],
      }))
      if(event==='client:create_directory')queueMicrotask(()=>ack?.({
        requestId:payload.requestId,
        workspaceId:'ws',
        parentPath:payload.parentPath,
        path:child,
        roots:[root],
        created:true,
      }))
    })
    const socket={emit,on:(event:string,fn:(value:any)=>void)=>listeners.set(event,fn),off:vi.fn()} as any
    function Harness(){const [value,setValue]=useState(root);return <DirectoryPicker socket={socket} workspaceId="ws" initialPath={root} value={value} onChange={setValue}/>}
    render(<Harness/>)
    await waitFor(()=>expect(screen.getByDisplayValue(root)).toBeTruthy())

    fireEvent.click(screen.getByTestId('dir-picker-new-folder'))
    fireEvent.change(screen.getByTestId('dir-picker-new-folder-name'),{target:{value:'created'}})
    fireEvent.click(screen.getByTestId('dir-picker-create-folder'))

    await waitFor(()=>expect(emit).toHaveBeenCalledWith('client:create_directory',expect.objectContaining({
      workspaceId:'ws',
      parentPath:root,
      name:'created',
    }),expect.any(Function)))
    await waitFor(()=>expect(screen.getByDisplayValue(child)).toBeTruthy())
  })
})
