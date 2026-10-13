export const listServerTask = () => useApi(`/api/servertasks`)
export const getServerTask = (id: number | string) => useApi(`/api/servertasks/${id}`)
export const createServerTask = (data: unknown) => useApi(`/api/servertasks`, { method: 'POST', body: data })
export const updateServerTask = (id: number | string, data: unknown) => useApi(`/api/servertasks/${id}`, { method: 'PUT', body: data })
export const deleteServerTask = (id: number | string) => useApi(`/api/servertasks/${id}`, { method: 'DELETE' })

export const getServerForServerTask = (record: { server_id: number | string }) =>
  useApi(`/api/servers/${record.server_id}`)
export const getUserForServerTask = (record: { user_id: number | string }) =>
  useApi(`/api/users/${record.user_id}`)
