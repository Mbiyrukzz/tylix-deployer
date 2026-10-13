import { createResource } from '../createResource.js'
import { listServer, createServer, updateServer, deleteServer } from './Server.js'

export function createServerResource() {
  return createResource({
    list: listServer,
    create: createServer,
    update: updateServer,
    remove: deleteServer,
  })
}
