interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: string
}

interface ResourceConfig<T> {
  list: (...args: unknown[]) => Promise<unknown>
  create: (payload: unknown) => Promise<unknown>
  update: (id: number | string, payload: unknown) => Promise<unknown>
  remove: (id: number | string) => Promise<unknown>
}

export function createResource<T extends { id: number | string }>({ list, create, update, remove }: ResourceConfig<T>) {
  return reactive({
    data: [] as T[],
    loading: false,
    error: null as string | null,
    async load(...args: unknown[]) {
      this.loading = true
      this.error = null
      const result = (await list(...args)) as ApiResult<T[]>
      if (result.ok && result.data) {
        this.data = result.data
      } else {
        this.error = result.error ?? 'Failed to load'
      }
      this.loading = false
      return result
    },
    async create(payload: unknown) {
      const result = (await create(payload)) as ApiResult<T>
      if (result.ok && result.data) this.data = [result.data, ...this.data]
      return result
    },
    async update(id: number | string, payload: unknown) {
      const result = (await update(id, payload)) as ApiResult<T>
      if (result.ok && result.data) {
        this.data = this.data.map((item) => (item.id === id ? result.data! : item))
      }
      return result
    },
    async remove(id: number | string) {
      const result = (await remove(id)) as ApiResult<null>
      if (result.ok) this.data = this.data.filter((item) => item.id !== id)
      return result
    },
  })
}
