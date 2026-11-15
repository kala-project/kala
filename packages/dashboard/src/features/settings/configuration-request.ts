import { createContext, useContext } from 'react'
import type { SettingsRequest } from './configuration-client.js'

export const SettingsRequestContext = createContext<SettingsRequest>((path, init) => fetch(path, init))
export const useSettingsRequest = (): SettingsRequest => useContext(SettingsRequestContext)
