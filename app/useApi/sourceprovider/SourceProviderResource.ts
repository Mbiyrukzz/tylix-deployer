import { createResource } from '../createResource.js'
import { listSourceProvider, createSourceProvider, updateSourceProvider, deleteSourceProvider } from './SourceProvider.js'

export function createSourceProviderResource() {
  return createResource({
    list: listSourceProvider,
    create: createSourceProvider,
    update: updateSourceProvider,
    remove: deleteSourceProvider,
  })
}
