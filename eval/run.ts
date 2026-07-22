import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { KNOWN_SMALL_COMPANIES } from '../companies.ts'
import { deepEnrich, triageJob } from '../agent.ts'
import type { Job } from '../types.ts'
import { detectJobSignals } from './hard-rules.ts'
import type { EvalResult, GoldenCase, GoldenSet } from './types.ts'

const GOLDEN = path.join(import.meta.dirname, 'golden.json')
const RESULTS_DIR = path.join(import.meta.dirname, 'results')
const DEEP_THRESHOLD = 7
const MAYBE_REVIEW_THRESHOLD = 6

const hasRunnableContent = (job: GoldenCase) => Boolean(job.description && job.description.trim())

const isTriageCorrect = (label: GoldenCase['label'], fitScore: number, matchType: string) => {
  const isSurfaceable = fitScore >= DEEP_THRESHOLD && matchType !== 'skip'
  const isReviewable = fitScore >= MAYBE_REVIEW_THRESHOLD && matchType !== 'skip'

  if (label === 'yes') return isSurfaceable
  if (label === 'maybe') return isReviewable
  return !isSurfaceable
}

const isDeepCorrect = (label: GoldenCase['label'], fitScore: number) => {
  if (label === 'yes') return fitScore >= DEEP_THRESHOLD
  if (label === 'maybe') return fitScore >= MAYBE_REVIEW_THRESHOLD
  return fitScore < DEEP_THRESHOLD
}

async function run() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY')

  const configName = process.argv[2] ?? 'default'
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf-8')) as GoldenSet
  const labeled = golden.cases.filter((job) => job.label && job.expectedScore > 0)
  const runnable = labeled.filter(hasRunnableContent)
  const missingDescription = labeled.filter((job) => !hasRunnableContent(job))

  if (missingDescription.length > 0) {
    console.error(
      `⚠️  ${missingDescription.length} casos no tienen description todavía. Se omiten del eval con modelo.`,
    )
  }

  if (runnable.length < 20) {
    console.error(`⚠️  Solo ${runnable.length} casos son corribles. Mínimo recomendado: 20.`)
  }

  console.error(`Running eval on ${runnable.length} runnable jobs (config: ${configName})...\n`)

  const results: EvalResult[] = []

  for (const g of runnable) {
    const fakeJob: Job = {
      id: g.id,
      company: g.company,
      title: g.title,
      location: g.location,
      url: g.url ?? '',
      description: g.description ?? '',
      source: 'greenhouse',
      postedAt: new Date().toISOString(),
    }

    try {
      const detectedSignals = detectJobSignals(fakeJob, {
        knownGoodCompanies: KNOWN_SMALL_COMPANIES,
        salaryFloor: 50,
      })
      const triage = await triageJob(fakeJob, apiKey)
      let deep = null

      if (triage.fitScore >= DEEP_THRESHOLD && triage.matchType !== 'skip') {
        deep = await deepEnrich(fakeJob, triage, apiKey)
      }

      const triageCorrect = isTriageCorrect(g.label, triage.fitScore, triage.matchType)

      results.push({
        id: g.id,
        company: g.company,
        title: g.title,
        expected: {
          label: g.label,
          score: g.expectedScore,
          matchType: g.expectedMatchType,
          redFlags: g.redFlags,
          greenFlags: g.greenFlags,
        },
        detectedSignals,
        triage,
        deep,
        triageCorrect,
        deepCorrect: deep ? isDeepCorrect(g.label, deep.fitScore) : null,
        scoreDiff: Math.abs(g.expectedScore - (deep?.fitScore ?? triage.fitScore)),
      })

      const status = triageCorrect ? '✓' : '✗'
      console.error(
        `${status} ${g.company} / ${g.title}: expected ${g.label}(${g.expectedScore}), got triage=${triage.fitScore}${deep ? ` deep=${deep.fitScore}` : ''}`,
      )
    } catch (error) {
      console.error(`✗ FAIL ${g.company}: ${(error as Error).message}`)
    }
  }

  const yesLabels = results.filter((result) => result.expected.label === 'yes')
  const noLabels = results.filter((result) => result.expected.label === 'no')
  const maybeLabels = results.filter((result) => result.expected.label === 'maybe')

  const triageTP = yesLabels.filter((result) => result.triage.fitScore >= DEEP_THRESHOLD).length
  const triageFP = noLabels.filter((result) => result.triage.fitScore >= DEEP_THRESHOLD).length
  const triageFN = yesLabels.filter((result) => result.triage.fitScore < DEEP_THRESHOLD).length

  const triagePrecision = triageTP / (triageTP + triageFP) || 0
  const triageRecall = triageTP / (triageTP + triageFN) || 0
  const triageF1 = (2 * triagePrecision * triageRecall) / (triagePrecision + triageRecall) || 0
  const maybeReviewRate =
    maybeLabels.filter((result) => result.triage.fitScore >= MAYBE_REVIEW_THRESHOLD).length /
      maybeLabels.length || 0

  const scoreMAE = results.reduce((sum, result) => sum + result.scoreDiff, 0) / (results.length || 1)
  const matchTypeCorrect = results.filter((result) => {
    const actual = result.deep?.matchType ?? result.triage.matchType
    return actual === result.expected.matchType
  }).length

  console.error('\n========== METRICS ==========')
  console.error(
    `Labeled: ${labeled.length} (runnable: ${results.length}, yes: ${yesLabels.length}, no: ${noLabels.length}, maybe review: ${maybeLabels.length})`,
  )
  console.error(`Missing descriptions: ${missingDescription.length}`)
  console.error(`\nPrimary metrics (yes vs no only):`)
  console.error(`  Precision: ${(triagePrecision * 100).toFixed(1)}%`)
  console.error(`  Recall:    ${(triageRecall * 100).toFixed(1)}%`)
  console.error(`  F1:        ${(triageF1 * 100).toFixed(1)}%`)
  console.error(`  False negatives: ${triageFN}/${yesLabels.length}`)
  console.error(`  False positives: ${triageFP}/${noLabels.length}`)
  console.error(`  Maybe surfaced for review: ${(maybeReviewRate * 100).toFixed(1)}%`)
  console.error(`\nScore MAE: ${scoreMAE.toFixed(2)}`)
  console.error(`Match type accuracy: ${((matchTypeCorrect / (results.length || 1)) * 100).toFixed(1)}%`)

  const failures = results.filter((result) => !result.triageCorrect)
  if (failures.length > 0) {
    console.error('\n========== FAILURES ==========')
    failures.forEach((result) => {
      console.error(`\n${result.company} / ${result.title}`)
      console.error(
        `  Expected: ${result.expected.label} (${result.expected.score}/${result.expected.matchType})`,
      )
      console.error(
        `  Got:      triage=${result.triage.fitScore}/${result.triage.matchType} — "${result.triage.reason}"`,
      )
      console.error(
        `  Signals:   red=[${result.detectedSignals.redFlags.join(', ')}] green=[${result.detectedSignals.greenFlags.join(', ')}]`,
      )
    })
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true })
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
  const outPath = path.join(RESULTS_DIR, `${timestamp}-${configName}.json`)
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        config: configName,
        timestamp,
        metrics: {
          totalLabeled: labeled.length,
          runnable: results.length,
          missingDescriptions: missingDescription.length,
          maybeReviewCount: maybeLabels.length,
          maybeReviewRate,
          triagePrecision,
          triageRecall,
          triageF1,
          scoreMAE,
          matchTypeAccuracy: matchTypeCorrect / (results.length || 1),
          falseNegatives: triageFN,
          falsePositives: triageFP,
        },
        results,
      },
      null,
      2,
    ),
  )
  console.error(`\n✓ Resultados completos en ${outPath}`)
}

run().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
