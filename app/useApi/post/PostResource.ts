import { createResource } from '../createResource.js'
import { listPost, createPost, updatePost, deletePost } from './Post.js'

export function createPostResource() {
  return createResource({
    list: listPost,
    create: createPost,
    update: updatePost,
    remove: deletePost,
  })
}
