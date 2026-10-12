declare function useApi<T = unknown>(
  url: string,
  options?: { method?: string; body?: unknown }
): Promise<T>
