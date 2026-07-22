/**
 * sources/ats-workable.ts
 *
 * Adapter para Workable jobs (sin auth, public board).
 *
 * NOTA IMPORTANTE: Workable cerró su public API JSON pero los embed widgets
 * exponen un endpoint que sigue funcionando. URL pattern:
 *
 *   https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
 *
 * Slug: el subdomain de apply.workable.com/{slug}
 *
 * Companies típicas EU: muchas scale-ups en España (e.g. algunas con HQ en BCN),
 * companies mid-market que migraron desde Workable Classic.
 *
 * Alternativa: si el endpoint widget no funciona para una company, fallback es
 * scrapear apply.workable.com/{slug}/ pero es frágil. Por ahora solo widget API.
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

export const fetchWorkable = async (slug: string): Promise<RawJob[]> => {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`${r.status}`)
  const data = (await r.json()) as { jobs?: any[] }

  return (data.jobs ?? []).map((j) => ({
    id: `wk-${slug}-${j.shortcode ?? j.id}`,
    title: j.title,
    location: [j.city, j.country].filter(Boolean).join(', ') || j.location?.location ||
      (j.workplace === 'remote' ? 'Remote' : ''),
    url: j.url ?? `https://apply.workable.com/${slug}/j/${j.shortcode}`,
    description: decodeHtml(stripHtml(j.description ?? '')),
    postedAt: j.published ?? j.created ?? new Date().toISOString(),
    department: j.department,
  }))
}
