/**
 * sources/types.ts
 *
 * Tipos compartidos entre todas las sources del agente.
 * Cada source debe devolver RawJob[] respetando este shape.
 */

export type ATS =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'personio'
  | 'teamtailor'
  | 'adzuna' // search-based, no slug
  | 'linkedin' // email-based, no slug

export type RawJob = {
  id: string
  title: string
  location: string
  url: string
  description: string
  postedAt: string
  department?: string
}

export type Job = RawJob & {
  company: string
  source: ATS
}

export type Company = {
  name: string
  ats: ATS
  slug: string
  careersUrl?: string
  notes?: string
}

// Cada adapter respeta esta firma. Map de adapters en agent.ts.
export type ATSAdapter = (slug: string) => Promise<RawJob[]>
