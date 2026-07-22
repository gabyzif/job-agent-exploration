/**
 * eval/run.ts
 *
 * Corre el pipeline de enrichment sobre golden.json y compara contra los labels.
 * Output: metrics + diffs por job (dónde el agente acertó/falló).
 *
 * Uso: bun eval/run.ts [config-name]
 *   - sin args: corre config default (lo que está en agent.ts)
 *   - con arg: carga eval/configs/{name}.json para overrides (model, threshold, etc.)
 *
 * Output:
 *   eval/results/{timestamp}-{config}.json  (resultados detallados)
 *   stdout: tabla de métricas
 */

import { triageJob, deepEnrich, type Job, type TriageResult } from '../agent.ts'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

type GoldenEntry = {
  jobId: string
  company: string
  title: string
  location: string
  url: string
  description: string
  label: 'yes' | 'no' | 'maybe'
  expectedScore: number
  expectedMatchType: 'direct' | 'stretch' | 'reach' | 'skip'
  reason: string
}

type EvalResult = {
  jobId: string
  company: string
  title: string
  expected: { label: string; score: number; matchType: string }
  triage: TriageResult
  deep: any | null
  // Métricas por job
  triageCorrect: boolean  // ¿triage scoreó >=7 cuando label=yes?
  deepCorrect: boolean | null  // ¿deep scoreó >=7 cuando label=yes? (null si no se hizo deep)
  scoreDiff: number  // |expected - actual|
}

const GOLDEN = path.join(import.meta.dirname, 'golden.json')
const RESULTS_DIR = path.join(import.meta.dirname, 'results')

const DEEP_THRESHOLD = 7  // mismo que agent.ts

async function run() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY')

  const configName = process.argv[2] ?? 'default'
  const golden: GoldenEntry[] = JSON.parse(await fs.readFile(GOLDEN, 'utf-8'))
  const labeled = golden.filter((g) => g.label !== '' && g.expectedScore > 0)

  if (labeled.length < 20) {
    console.error(`⚠️  Solo ${labeled.length} jobs labeled. Mínimo recomendado: 30. Resultados serán ruidosos.`)
  }

  console.error(`Running eval on ${labeled.length} labeled jobs (config: ${configName})...\n`)

  const results: EvalResult[] = []
  for (const g of labeled) {
    const fakeJob: Job = {
      id: g.jobId,
      company: g.company,
      title: g.title,
      location: g.location,
      url: g.url,
      description: g.description,
      source: 'greenhouse',  // no importa para enrichment
      postedAt: new Date().toISOString(),
    }

    try {
      const triage = await triageJob(fakeJob, apiKey)
      let deep = null
      if (triage.fitScore >= DEEP_THRESHOLD && triage.matchType !== 'skip') {
        deep = await deepEnrich(fakeJob, triage, apiKey)
      }

      const expectedYes = g.label === 'yes'
      const triageSaidYes = triage.fitScore >= DEEP_THRESHOLD && triage.matchType !== 'skip'
      const deepSaidYes = deep ? deep.fitScore >= 7 : false

      results.push({
        jobId: g.jobId,
        company: g.company,
        title: g.title,
        expected: { label: g.label, score: g.expectedScore, matchType: g.expectedMatchType },
        triage,
        deep,
        triageCorrect: expectedYes === triageSaidYes,
        deepCorrect: deep ? expectedYes === deepSaidYes : null,
        scoreDiff: Math.abs(g.expectedScore - (deep?.fitScore ?? triage.fitScore)),
      })

      const status = expectedYes === triageSaidYes ? '✓' : '✗'
      console.error(`${status} ${g.company} / ${g.title}: expected ${g.label}(${g.expectedScore}), got triage=${triage.fitScore} ${deep ? `deep=${deep.fitScore}` : ''}`)
    } catch (err) {
      console.error(`✗ FAIL ${g.company}: ${(err as Error).message}`)
    }
  }

  // ---------- Métricas ----------

  const yesLabels = results.filter((r) => r.expected.label === 'yes')
  const noLabels = results.filter((r) => r.expected.label === 'no')

  // Triage: ¿el filtro de Haiku captura los yes y rechaza los no?
  const triageTP = yesLabels.filter((r) => r.triage.fitScore >= DEEP_THRESHOLD).length  // dijo yes, era yes
  const triageFP = noLabels.filter((r) => r.triage.fitScore >= DEEP_THRESHOLD).length   // dijo yes, era no
  const triageFN = yesLabels.filter((r) => r.triage.fitScore < DEEP_THRESHOLD).length   // dijo no, era yes (¡los perdidos!)
  const triageTN = noLabels.filter((r) => r.triage.fitScore < DEEP_THRESHOLD).length

  const triagePrecision = triageTP / (triageTP + triageFP) || 0
  const triageRecall = triageTP / (triageTP + triageFN) || 0
  const triageF1 = (2 * triagePrecision * triageRecall) / (triagePrecision + triageRecall) || 0

  // Score MAE: ¿qué tan lejos están los scores numéricos?
  const scoreMAE = results.reduce((sum, r) => sum + r.scoreDiff, 0) / results.length

  // Match type accuracy
  const matchTypeCorrect = results.filter((r) => {
    const actual = r.deep?.matchType ?? r.triage.matchType
    return actual === r.expected.matchType
  }).length

  console.error('\n========== METRICS ==========')
  console.error(`Labeled: ${results.length} (yes: ${yesLabels.length}, no: ${noLabels.length})`)
  console.error(`\nTriage (¿captura los buenos? ¿rechaza los malos?):`)
  console.error(`  Precision: ${(triagePrecision * 100).toFixed(1)}% — cuando dijo "yes", acertó`)
  console.error(`  Recall:    ${(triageRecall * 100).toFixed(1)}% — capturó los "yes" reales`)
  console.error(`  F1:        ${(triageF1 * 100).toFixed(1)}%`)
  console.error(`  ⚠️  False negatives (perdidos): ${triageFN}/${yesLabels.length}`)
  console.error(`  ⚠️  False positives (ruido): ${triageFP}/${noLabels.length}`)
  console.error(`\nScore MAE: ${scoreMAE.toFixed(2)} (qué tan lejos están los scores en promedio)`)
  console.error(`Match type accuracy: ${((matchTypeCorrect / results.length) * 100).toFixed(1)}%`)

  // Casos donde falló: para inspección manual
  const failures = results.filter((r) => !r.triageCorrect)
  if (failures.length > 0) {
    console.error(`\n========== FAILURES (revisar manualmente) ==========`)
    failures.forEach((r) => {
      console.error(`\n${r.company} / ${r.title}`)
      console.error(`  Expected: ${r.expected.label} (${r.expected.score}/${r.expected.matchType})`)
      console.error(`  Got:      triage=${r.triage.fitScore}/${r.triage.matchType} — "${r.triage.reason}"`)
    })
  }

  // Guardar
  await fs.mkdir(RESULTS_DIR, { recursive: true })
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
  const outPath = path.join(RESULTS_DIR, `${timestamp}-${configName}.json`)
  await fs.writeFile(outPath, JSON.stringify({
    config: configName,
    timestamp,
    metrics: {
      total: results.length,
      triagePrecision,
      triageRecall,
      triageF1,
      scoreMAE,
      matchTypeAccuracy: matchTypeCorrect / results.length,
      falseNegatives: triageFN,
      falsePositives: triageFP,
    },
    results,
  }, null, 2))
  console.error(`\n✓ Resultados completos en ${outPath}`)
}

run().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
