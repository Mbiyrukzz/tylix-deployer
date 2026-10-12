export const postApi = (table: string, data: unknown) =>
  useApi(`/api/${table}`, { method: 'POST', body: data })
