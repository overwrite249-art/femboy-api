"use client"
import { createContext, useContext } from "react"
import type { ConsoleUser } from "./api.ts"
export const SessionContext = createContext<ConsoleUser | null>(null)
export const useSession = () => useContext(SessionContext)
