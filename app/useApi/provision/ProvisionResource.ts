import { createResource } from '../createResource.js'
import { listProvision, createProvision, updateProvision, deleteProvision } from './Provision.js'

export function createProvisionResource() {
  return createResource({
    list: listProvision,
    create: createProvision,
    update: updateProvision,
    remove: deleteProvision,
  })
}
