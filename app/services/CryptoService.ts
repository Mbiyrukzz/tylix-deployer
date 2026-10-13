import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'

function getKey(): Buffer {
  const raw = process.env.APP_KEY
  if (!raw) {
    throw new Error('APP_KEY is not set. Generate one with: openssl rand -base64 32')
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('APP_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32')
  }

  return key
}

/**
 * Encrypts secrets at rest (SSH private keys, env var values).
 *
 * Payload format: v1:<iv>:<authTag>:<ciphertext>  (all base64)
 * The version prefix lets us rotate algorithms or keys later
 * without breaking rows that were encrypted with the old scheme.
 */
export class CryptoService {
  static encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, getKey(), iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':')
  }

  static decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':')

    if (version !== VERSION || !iv || !tag || !data) {
      throw new Error('Invalid encrypted payload')
    }

    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))

    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
}