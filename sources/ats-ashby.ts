/**
 * sources/ats-ashby.ts
 *
 * Adapter para Ashby jobs API.
 * Docs: https://developers.ashbyhq.com/reference/jobboardapi
 *
 * URL: https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 * Slug: aparece en jobs.ashbyhq.com/{slug}
 *
 * Companies típicas: Linear, Resend, Cal.com, Mistral, muchas AI-native nuevas.
 * Ashby es el ATS más relevante para tu nicho (design-eng/AI/dev tools).
 *
 * Nota: includeCompensation=true te trae salary ranges cuando la company los publica.
 * Útil para el agente porque algunos roles tienen banda explícita.
 */

import type { RawJob } from './types.ts'

export const fetchAshby = async (slug: string): Promise<RawJob[]> => {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}`)
  const data = (await r.json()) as { jobs?: any[] }

  return (data.jobs ?? []).map((j) => ({
    id: `ab-${slug}-${j.id}`,
    title: j.title,
    location: j.locationName ?? '',
    url: j.jobUrl ?? j.applyUrl,
    description: j.descriptionPlain ?? '',
    postedAt: j.publishedAt ?? new Date().toISOString(),
    department: j.departmentName,
  }))
}
