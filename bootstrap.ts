/**
 * eval/bootstrap.ts
 *
 * Corre los adapters + filtros (SIN Claude) y guarda los primeros N jobs
 * en eval/golden.unlabeled.json para que G los clasifique manualmente.
 *
 * Uso: bun eval/bootstrap.ts [N]    (default N=40)
 */

import { companies } from '../companies.ts'
import { atsAdapters, passesFilters, type Job } from '../agent.ts'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const N = parseInt(process.argv[2] ?? '40', 10)
const OUT = path.join(import.meta.dirname, 'golden.unlabeled.json')

async function run() {
  const results = await Promise.allSettled(
    companies.map(async (c): Promise<Job[]> => {
      const raw = await atsAdapters[c.ats](c.slug)
      return raw.map((j) => ({ ...j, company: c.name, source: c.ats }))
    }),
  )

  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const filtered = all.filter(passesFilters)
  console.error(`fetched ${all.length}, filtered ${filtered.length}`)

  // Muestreo: queremos variedad, no los primeros 40 que casi siempre son de la misma company.
  // Tomamos uno de cada company hasta llenar N (round-robin).
  const byCompany = new Map<string, Job[]>()
  for (const j of filtered) {
    const list = byCompany.get(j.company) ?? []
    list.push(j)
    byCompany.set(j.company, list)
  }

  const sampled: Job[] = []
  let i = 0
  while (sampled.length < N) {
    let added = false
    for (const list of byCompany.values()) {
      if (i < list.length) {
        sampled.push(list[i])
        added = true
        if (sampled.length >= N) break
      }
    }
    if (!added) break // se acabaron
    i++
  }

  // Estructura para labeling: deja campos vacíos para que G complete
  const golden = sampled.map((j) => ({
    jobId: j.id,
    company: j.company,
    title: j.title,
    location: j.location,
    url: j.url,
    description: j.description.slice(0, 1500),
    // ↓ G completa esto manualmente
    label: '' as 'yes' | 'no' | 'maybe' | '',
    expectedScore: 0,
    expectedMatchType: '' as 'direct' | 'stretch' | 'reach' | 'skip' | '',
    reason: '',
  }))

  await fs.writeFile(OUT, JSON.stringify(golden, null, 2))
  console.error(`\n✓ ${sampled.length} jobs guardados en ${OUT}`)
  console.error(`\nProximo paso: abrí el archivo, completá los campos label/expectedScore/expectedMatchType/reason de cada job, guardalo como golden.json (sin "unlabeled")`)
}

run().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
