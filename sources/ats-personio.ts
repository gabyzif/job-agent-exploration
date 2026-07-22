/**
 * sources/ats-personio.ts
 *
 * Adapter para Personio recruiting (XML feed público).
 * Docs: https://developer.personio.de/docs/retrieving-open-job-positions
 *
 * URL: https://{slug}.jobs.personio.de/xml
 * Slug: el subdomain de {slug}.jobs.personio.de o {slug}.personio.com
 *
 * Companies típicas EU: muchas scale-ups DACH (Alemania/Austria/Suiza),
 * algunas EU south. Personio mismo es el ATS de muchas companies EU porque
 * Personio es company alemana de HR software.
 *
 * Formato: XML feed con todas las posiciones abiertas. Parseamos con regex
 * para no depender de librerías XML externas.
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

const pickTag = (xml: string, tag: string): string => {
  const m = xml.match(
    new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`),
  )
  return m?.[1]?.trim() ?? ''
}

const pickAllTags = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'g')
  return [...xml.matchAll(re)].map((m) => m[1].trim())
}

export const fetchPersonio = async (slug: string): Promise<RawJob[]> => {
  const url = `https://${slug}.jobs.personio.de/xml`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}`)
  const xml = await r.text()

  const positions = [...xml.matchAll(/<position[^>]*>([\s\S]*?)<\/position>/g)]

  return positions.map((m): RawJob => {
    const block = m[1]

    // Personio agrupa varias jobDescriptions con name+value, las concatenamos
    const descriptionBlocks = pickAllTags(block, 'value')
    const description = decodeHtml(stripHtml(descriptionBlocks.join('\n\n')))

    return {
      id: `pe-${slug}-${pickTag(block, 'id')}`,
      title: pickTag(block, 'name'),
      location: pickTag(block, 'office') ||
        [pickTag(block, 'subcompany'), pickTag(block, 'department')].filter(Boolean).join(', '),
      url: `https://${slug}.jobs.personio.de/job/${pickTag(block, 'id')}`,
      description,
      postedAt: pickTag(block, 'createdAt') || new Date().toISOString(),
      department: pickTag(block, 'department'),
    }
  })
}
