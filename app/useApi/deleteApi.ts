export const deleteApi = (table: string, id: number | string) =>
  useApi(`/api/${table}/${id}`, { method: 'DELETE' })
