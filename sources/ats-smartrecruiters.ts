/**
 * sources/ats-smartrecruiters.ts
 *
 * Adapter para SmartRecruiters Posting API (free, sin auth).
 * Docs: https://developers.smartrecruiters.com/docs/posting-api-introduction
 *
 * URL: https://api.smartrecruiters.com/v1/companies/{slug}/postings
 * Slug: typically la company en lowercase sin espacios. Para verificar:
 *   1. Ir a la careers page (usually careers.{company}.com o {company}.smartrecruiters.com)
 *   2. Ver el subdomain → ese es el slug
 *
 * Companies típicas EU: NTT Data, Capgemini variants, varias consultoras
 * grandes españolas. También algunas tech companies enterprise.
 *
 * Hay paginación pero raramente >100 jobs por company en frontend, así que
 * primera página (default 10) suele alcanzar. Para más, agregar ?limit=100.
 *
 * IMPORTANTE: SmartRecruiters NO devuelve description en list endpoint, solo título
 * y location. Hay que hacer un segundo fetch por job al endpoint /postings/{id}.
 * Para evitar disparar 50+ requests por company, solo enriquecemos descripción
 * para jobs que pasan el pre-filter de título.
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

const fetchJobDetails = async (slug: string, postingId: string): Promise<string> => {
  try {
    const r = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${postingId}`,
    )
    if (!r.ok) return ''
    const data = (await r.json()) as any
    const sections = data.jobAd?.sections ?? {}
    const parts = [
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ].filter(Boolean)
    return decodeHtml(stripHtml(parts.join('\n\n')))
  } catch {
    return ''
  }
}

export const fetchSmartRecruiters = async (slug: string): Promise<RawJob[]> => {
  const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}`)
  const data = (await r.json()) as { content: any[] }

  // Pre-filter por título (solo trae descripción si el título matchea)
  const titleMatchesTech = (title: string) =>
    /front|back|full|software|engineer|developer|design|ai|ml/i.test(title)

  const jobs: RawJob[] = []
  for (const j of data.content) {
    const baseJob: RawJob = {
      id: `sr-${slug}-${j.id}`,
      title: j.name,
      location: j.location
        ? `${j.location.city ?? ''}, ${j.location.country ?? ''}`.replace(/^, |, $/g, '')
        : '',
      url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      description: '', // se enriquece abajo si pasa pre-filter
      postedAt: j.releasedDate ?? j.createdOn ?? new Date().toISOString(),
      department: j.department?.label,
    }

    if (titleMatchesTech(j.name)) {
      baseJob.description = await fetchJobDetails(slug, j.id)
    }

    jobs.push(baseJob)
  }

  return jobs
}
