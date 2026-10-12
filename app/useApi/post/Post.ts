export const listPost = () => useApi(`/api/posts`)
export const getPost = (id: number | string) => useApi(`/api/posts/${id}`)
export const createPost = (data: unknown) => useApi(`/api/posts`, { method: 'POST', body: data })
export const updatePost = (id: number | string, data: unknown) => useApi(`/api/posts/${id}`, { method: 'PUT', body: data })
export const deletePost = (id: number | string) => useApi(`/api/posts/${id}`, { method: 'DELETE' })

export const getUserForPost = (record: { user_id: number | string }) =>
  useApi(`/api/users/${record.user_id}`)
