/**
 * sources/ats-teamtailor.ts
 *
 * Adapter para TeamTailor career site (JSON-LD scraping de la página pública).
 *
 * NOTA: TeamTailor tiene API oficial pero requiere API key del employer.
 * Las career pages públicas exponen JSON-LD con todos los jobs, que es
 * estable y machine-readable, así que parseamos eso.
 *
 * URL: https://{slug}.teamtailor.com/jobs.json
 * Slug: el subdomain de {slug}.teamtailor.com
 *
 * Companies típicas EU: scale-ups Nordics, mucho en Spain/Portugal,
 * algunas startups de design-eng.
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

export const fetchTeamTailor = async (slug: string): Promise<RawJob[]> => {
  // TeamTailor expone un endpoint JSON simple en /jobs.json
  const url = `https://${slug}.teamtailor.com/jobs.json`
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'jobs-agent/0.2' },
  })
  if (!r.ok) throw new Error(`${r.status}`)

  // El response puede venir como array o como object con `data`
  const raw = await r.json()
  const jobs: any[] = Array.isArray(raw) ? raw : (raw.data ?? raw.jobs ?? [])

  return jobs.map((j) => {
    const attrs = j.attributes ?? j
    const fallbackLocation =
      [attrs['location-name'], attrs.region].filter(Boolean).join(', ') || (attrs.remote ? 'Remote' : '')
    const fallbackUrl =
      attrs['careersite-job-url'] ?? `https://${slug}.teamtailor.com/jobs/${j.id ?? attrs.slug}`

    return {
      id: `tt-${slug}-${j.id ?? attrs.slug}`,
      title: attrs.title ?? '',
      location: attrs.location?.name ?? fallbackLocation,
      url: attrs.url ?? fallbackUrl,
      description: decodeHtml(stripHtml(attrs.body ?? attrs.description ?? '')),
      postedAt: attrs['published-at'] ?? attrs['created-at'] ?? new Date().toISOString(),
      department: attrs.department?.name ?? attrs['department-name'],
    }
  })
}
