/**
 * Checks whether the AI Gateway will actually serve Jev requests.
 *
 * Run it after changing anything on the Vercel side. It never prints the key.
 *
 *   npm run check-gateway
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const settings = JSON.parse(
  readFileSync(`${homedir()}/.claude/settings.json`, 'utf8'),
)
const key = settings?.env?.AI_GATEWAY_API_KEY

if (!key) {
  console.error('No AI_GATEWAY_API_KEY in the env block of ~/.claude/settings.json.')
  process.exit(1)
}

const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12)
console.log(`key            ${key.length} chars, sha256[:12]=${fingerprint}`)

const auth = { authorization: `Bearer ${key}` }

const credits = await fetch('https://ai-gateway.vercel.sh/v1/credits', {
  headers: auth,
})
const balance = credits.ok ? await credits.json() : null

if (!credits.ok) {
  console.log(`credits        HTTP ${credits.status} — the key itself is not being accepted`)
  process.exit(1)
}

console.log(`credits        balance ${balance.balance}, used ${balance.total_used}`)

const probe = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'typesafe-ai/jev',
    state: 'what is 2+2',
    questions: {
      tier: {
        type: 'choice',
        instructions: 'Which tier should answer this?',
        criteria: { haiku: 'trivial', opus: 'implementation' },
      },
    },
  }),
})

const text = (await probe.text()).replaceAll(key, '<REDACTED>')

if (probe.ok) {
  const answer = JSON.parse(text)
  console.log(`evaluate       HTTP 200 — Jev answered "${answer.answers?.tier?.choice}"`)
  console.log('\nThe gateway is serving. jev-router will route.')
  process.exit(0)
}

console.log(`evaluate       HTTP ${probe.status}`)
console.log(text.slice(0, 400))

if (Number(balance.balance) === 0) {
  console.log(
    '\nBalance is 0, so this account has never been granted credits. ' +
      'Whatever card was added went to a different Vercel scope than the one ' +
      'this key belongs to. Add it to this scope, or make a new key under the ' +
      'scope that has the card.',
  )
}
process.exit(1)
