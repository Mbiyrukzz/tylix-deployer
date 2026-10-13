export const listSourceProvider = () => useApi(`/api/sourceproviders`)
export const getSourceProvider = (id: number | string) => useApi(`/api/sourceproviders/${id}`)
export const createSourceProvider = (data: unknown) => useApi(`/api/sourceproviders`, { method: 'POST', body: data })
export const updateSourceProvider = (id: number | string, data: unknown) => useApi(`/api/sourceproviders/${id}`, { method: 'PUT', body: data })
export const deleteSourceProvider = (id: number | string) => useApi(`/api/sourceproviders/${id}`, { method: 'DELETE' })

export const getUserForSourceProvider = (record: { user_id: number | string }) =>
  useApi(`/api/users/${record.user_id}`)
