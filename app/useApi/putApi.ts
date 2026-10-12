export const putApi = (table: string, id: number | string, data: unknown) =>
  useApi(`/api/${table}/${id}`, { method: 'PUT', body: data })
