#!/usr/bin/env node
/**
 * Live host verification helper for ui-evolve.
 *
 * Signs a local DSH browser-session cookie from `$DSH_HOME/.credentials.yaml`
 * (using the verified algorithm documented in docs/handover/index.md 2026-11-14)
 * and probes the running host's `/api/ui-evolve/*` endpoint.
 *
 * Usage:
 *   node scripts/verify-live.mjs                         # probe /api/ui-evolve/config
 *   node scripts/verify-live.mjs --session <session-id>  # probe /api/ui-evolve/panel?agent=<id>
 *   node scripts/verify-live.mjs --host 127.0.0.1:19387  # custom authority
 *   node scripts/verify-live.mjs --print-cookie          # only print signed Cookie header
 */

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback
}

function readBrowserSessionSecret(dshHome) {
  const credPath = join(dshHome, '.credentials.yaml')
  if (!existsSync(credPath)) {
    throw new Error(`Credentials file not found: ${credPath}`)
  }
  const text = readFileSync(credPath, 'utf8')
  const block = text.match(/client-connection\/browser-session[\s\S]*?secret:\s*['"]?([A-Za-z0-9_-]{43})['"]?/)
  if (!block) {
    throw new Error(`Could not find 43-char base64url secret for client-connection/browser-session in ${credPath}`)
  }
  const secretBytes = Buffer.from(block[1], 'base64url')
  if (secretBytes.byteLength !== 32) {
    throw new Error(`Decoded secret length is ${secretBytes.byteLength} bytes (expected 32)`)
  }
  return secretBytes
}

function signCookie(authority, secretBytes) {
  const now = Date.now()
  const payload = {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 10 * 60 * 1000,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secretBytes).update(body).digest('base64url')
  const nameHash = createHash('sha256').update(authority).digest('base64url')
  return `dsh-auth-${nameHash}=v1.${body}.${sig}`
}

async function main() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const authority = argValue('--host', '127.0.0.1:19387')
  const sessionId = argValue('--session', '')
  const route = argValue(
    '--route',
    sessionId ? `/api/ui-evolve/panel?agent=${encodeURIComponent(sessionId)}` : '/api/ui-evolve/config',
  )
  const printOnly = process.argv.includes('--print-cookie')

  const secret = readBrowserSessionSecret(dshHome)
  const cookie = signCookie(authority, secret)

  if (printOnly) {
    console.log(cookie)
    return
  }

  const url = `http://${authority}${route}`
  const res = await fetch(url, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  })
  const text = await res.text()
  console.log(`GET ${url} -> HTTP ${res.status}`)
  if (!res.ok) {
    console.error(text.slice(0, 400))
    process.exit(1)
  }
  try {
    const json = JSON.parse(text)
    console.log('Top-level keys:', Object.keys(json).join(', '))
  } catch {
    console.log('Body preview:', text.slice(0, 200))
  }
}

main().catch((err) => {
  console.error(`verify-live failed: ${err.message}`)
  process.exit(1)
})
