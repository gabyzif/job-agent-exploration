/**
 * sources/ats-greenhouse.ts
 *
 * Adapter para Greenhouse jobs API.
 * Docs: https://developers.greenhouse.io/job-board.html
 *
 * URL: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 * Slug: aparece en la URL de la careers page (boards.greenhouse.io/{slug})
 *
 * Companies típicas: Datadog, Stripe, Anthropic, Wise, Pleo, Contentful,
 * Miro, TravelPerk, Typeform, Glovo, N26, DeepL
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

export const fetchGreenhouse = async (slug: string): Promise<RawJob[]> => {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}`)
  const data = (await r.json()) as { jobs: any[] }

  return data.jobs.map((j) => ({
    id: `gh-${slug}-${j.id}`,
    title: j.title,
    location: j.location?.name ?? '',
    url: j.absolute_url,
    description: decodeHtml(stripHtml(j.content ?? '')),
    postedAt: j.updated_at,
    department: j.departments?.[0]?.name,
  }))
}
