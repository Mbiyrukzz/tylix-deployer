declare function useApi<T = unknown>(
  url: string,
  options?: { method?: string; body?: unknown }
): Promise<T>


/** The app shell from public/app-shell.js (persistent sidebar, in-place navigation). */
interface FluxShell {
  native: Record<string, any>
  /** addEventListener that page cleanup never removes; returns an unsubscribe function. */
  on(target: EventTarget, type: string, fn: (event: any) => void, options?: AddEventListenerOptions | boolean): () => void
  emit(name: string, detail?: unknown): void
  /** setInterval that page cleanup never clears; returns a stop function. */
  every(ms: number, fn: () => void): () => void
  /** setTimeout that page cleanup never clears; returns a cancel function. */
  later(ms: number, fn: () => void): () => void
  isAppPath(pathname: string): boolean
  navigate(url: string): void
  toast(options: string | { title: string; text?: string; tone?: "neutral" | "ok" | "warn" | "error"; id?: string; timeout?: number; action?: { label: string; href?: string; run?: () => void } }): () => void
  sidebar(state?: "collapsed" | "expanded"): "collapsed" | "expanded"
  theme(mode?: "dark" | "light"): "dark" | "light"
  swapping: boolean
}

interface Window {
  __flux?: FluxShell
  __fluxSwap?: boolean
}
