import { createResource } from '../createResource.js'
import { listSite, createSite, updateSite, deleteSite } from './Site.js'

export function createSiteResource() {
  return createResource({
    list: listSite,
    create: createSite,
    update: updateSite,
    remove: deleteSite,
  })
}
