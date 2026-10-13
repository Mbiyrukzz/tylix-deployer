import { createResource } from '../createResource.js'
import { listProvider, createProvider, updateProvider, deleteProvider } from './Provider.js'

export function createProviderResource() {
  return createResource({
    list: listProvider,
    create: createProvider,
    update: updateProvider,
    remove: deleteProvider,
  })
}
