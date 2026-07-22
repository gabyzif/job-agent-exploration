import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { companies } from '../companies.ts'
import { passesFilters } from '../agent.ts'
import { atsAdapters } from '../index.ts'
import type { Job } from '../types.ts'
import type { GoldenSet } from './types.ts'

const N = parseInt(process.argv[2] ?? '40', 10)
const OUT = path.join(import.meta.dirname, 'golden.unlabeled.json')

async function run() {
  const results = await Promise.allSettled(
    companies.map(async (company): Promise<Job[]> => {
      const raw = await atsAdapters[company.ats](company.slug)
      return raw.map((job) => ({ ...job, company: company.name, source: company.ats }))
    }),
  )

  const all = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  const filtered = all.filter(passesFilters)
  console.error(`fetched ${all.length}, filtered ${filtered.length}`)

  const byCompany = new Map<string, Job[]>()
  for (const job of filtered) {
    const list = byCompany.get(job.company) ?? []
    list.push(job)
    byCompany.set(job.company, list)
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
    if (!added) break
    i++
  }

  const golden: GoldenSet = {
    _meta: {
      version: '1.1',
      labeler: 'G',
      createdAt: new Date().toISOString().slice(0, 10),
      labelingRules: {
        label: 'yes | no | maybe',
        expectedScore: '1-10 integer, how G honestly scores the fit',
        expectedMatchType: 'direct | stretch | reach | skip',
        evalCounting: 'yes vs not-yes for precision/recall. maybe excluded from primary metrics but kept for analysis.',
      },
    },
    cases: sampled.map((job) => ({
      id: job.id,
      company: job.company,
      title: job.title,
      location: job.location,
      url: job.url,
      description: job.description.slice(0, 2000),
      label: 'maybe',
      expectedScore: 0,
      expectedMatchType: 'skip',
      reason: '',
      redFlags: [],
      greenFlags: [],
      notes: '',
    })),
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, JSON.stringify(golden, null, 2))
  console.error(`\n✓ ${sampled.length} jobs guardados en ${OUT}`)
  console.error('\nPróximo paso: completar label/expectedScore/expectedMatchType/reason y signals.')
}

run().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
