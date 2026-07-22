/**
 * sources/ats-lever.ts
 *
 * Adapter para Lever jobs API.
 * Docs: https://github.com/lever/postings-api
 *
 * URL: https://api.lever.co/v0/postings/{slug}?mode=json
 * Slug: aparece en jobs.lever.co/{slug}
 *
 * Companies típicas: Hugging Face, Hevy, varias AI startups
 */

import type { RawJob } from './types.ts'

export const fetchLever = async (slug: string): Promise<RawJob[]> => {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}`)
  const data = (await r.json()) as any[]

  return data.map((j) => ({
    id: `lv-${slug}-${j.id}`,
    title: j.text,
    location: j.categories?.location ?? '',
    url: j.hostedUrl,
    description: j.descriptionPlain ?? '',
    postedAt: new Date(j.createdAt).toISOString(),
    department: j.categories?.team,
  }))
}
