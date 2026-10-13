import { createResource } from '../createResource.js'
import { listServerTask, createServerTask, updateServerTask, deleteServerTask } from './ServerTask.js'

export function createServerTaskResource() {
  return createResource({
    list: listServerTask,
    create: createServerTask,
    update: updateServerTask,
    remove: deleteServerTask,
  })
}
