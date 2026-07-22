/**
 * sources/search-adzuna.ts
 *
 * Adzuna search API - diferente a los ATS adapters porque busca por query,
 * no por company slug. Te descubre companies nuevas que no están en tu lista.
 *
 * Docs: https://developer.adzuna.com/docs/search
 * Setup:
 *   1. Registrate gratis en https://developer.adzuna.com/
 *   2. Te dan app_id + app_key
 *   3. envs: ADZUNA_APP_ID, ADZUNA_APP_KEY
 *
 * Free tier: 250 requests/mes. Para mantenerse seguro, corremos solo 1 vez/día
 * con queries fijas de descubrimiento.
 *
 * Países disponibles: gb, us, at, au, br, ca, de, fr, in, it, mx, nl, nz, pl,
 * sg, ru, za, es. Default 'es' (España) para G.
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

export type AdzunaQuery = {
  what: string // keywords ej "senior frontend"
  where?: string // location ej "barcelona", o vacío para nationwide
  resultsPerPage?: number // max 50
  country?: string // default 'es'
}

const fetchSingleQuery = async (
  q: AdzunaQuery,
  appId: string,
  appKey: string,
): Promise<RawJob[]> => {
  const country = q.country ?? 'es'
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what: q.what,
    results_per_page: String(q.resultsPerPage ?? 50),
  })
  if (q.where) params.set('where', q.where)

  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`adzuna ${r.status}: ${await r.text()}`)
  const data = (await r.json()) as { results: any[] }

  return data.results.map((j: any): RawJob => ({
    id: `adz-${country}-${j.id}`,
    title: j.title,
    company: j.company?.display_name ?? 'Unknown',
    location: j.location?.display_name ?? '',
    url: j.redirect_url,
    description: decodeHtml(stripHtml(j.description ?? '')),
    postedAt: j.created,
  }) as any)
}

/**
 * Corre las queries de Adzuna ajustadas al perfil de G.
 * Solo se debe correr 1x/día para no quemar el free tier.
 */
export const fetchAdzuna = async (
  appId: string,
  appKey: string,
): Promise<RawJob[]> => {
  if (!appId || !appKey) {
    throw new Error('Faltan ADZUNA_APP_ID / ADZUNA_APP_KEY en envs')
  }

  // Queries calibradas a tu perfil: buscar títulos que G no revisaría manualmente.
  const queries: AdzunaQuery[] = [
    { what: 'react', where: 'barcelona', resultsPerPage: 25 },
    { what: 'frontend', where: 'barcelona', resultsPerPage: 25 },
    { what: 'typescript', resultsPerPage: 25 },
    { what: 'full stack engineer react typescript', resultsPerPage: 25 },
    { what: 'ai engineer react typescript', resultsPerPage: 25 },
    { what: 'design engineer', resultsPerPage: 25 },
  ]

  const results = await Promise.allSettled(
    queries.map((q) => fetchSingleQuery(q, appId, appKey)),
  )

  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))

  // Dedupe intra-Adzuna (mismo job puede aparecer en múltiples queries)
  const seen = new Set<string>()
  return all.filter((j) => {
    if (seen.has(j.id)) return false
    seen.add(j.id)
    return true
  })
}
