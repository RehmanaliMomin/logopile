#!/usr/bin/env node
/**
 * Run the query harnesses and report a trustworthy pass/fail.
 *
 * Why this wrapper exists: onnxruntime aborts during process teardown on
 * Node 25 ("libc++abi: mutex lock failed") AFTER the harness has finished and
 * printed its results, so the process exits 134 on a run that passed. Disposing
 * the session and forcing a single thread both failed to prevent it.
 *
 * So the exit code is not evidence. Each harness prints `CHECK_OK <name>` as its
 * final act, and this wrapper believes that instead — while still failing if a
 * harness prints CHECK_FAIL, prints nothing, or dies before reaching the end.
 */
import { spawnSync } from 'node:child_process'

const HARNESSES = ['scripts/smoke.mjs', 'scripts/stress.mjs', 'scripts/validate-suggestions.mjs']

let failed = 0
for (const script of HARNESSES) {
  process.stdout.write(`\n── ${script} ${'─'.repeat(Math.max(0, 50 - script.length))}\n`)
  const r = spawnSync('node', [script], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}`
  process.stdout.write(out)

  const ok = /^CHECK_OK /m.test(out)
  const explicitFail = /^CHECK_FAIL /m.test(out)
  if (ok && !explicitFail) {
    console.log(`✓ ${script}`)
  } else {
    failed++
    console.error(`✗ ${script} — ${explicitFail ? 'reported failure' : 'did not reach its verdict'}`)
    if (r.stderr && !ok) console.error(r.stderr.split('\n').slice(-6).join('\n'))
  }
}

console.log(failed ? `\n${failed} harness(es) failed` : '\nall harnesses passed')
process.exit(failed ? 1 : 0)
