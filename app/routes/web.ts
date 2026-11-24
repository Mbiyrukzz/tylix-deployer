import type { Router } from '@tylix/core'
import { ACCESS_TOKEN_COOKIE } from '@tylix/auth'
import { authController } from '../controllers/AuthController.js'
import { impersonationMiddleware } from '../services/FluxAdmin.js'

export async function routes(router: Router) {
  // While a Flux admin is signed in as a user: refuses the routes that
  // would take over the account or move money, and tags the request so
  // server logs record the admin (app/services/FluxAdmin.ts). The
  // controller is looked up per request: it is created after this file runs.
  router.use(
    impersonationMiddleware(
      (token) => authController().auth.verifyAccessToken(token),
      ACCESS_TOKEN_COOKIE,
    ) as Parameters<Router['use']>[0],
  )
}
