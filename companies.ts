/**
 * companies.ts
 *
 * Target list: 100+ employees, design-eng culture, OR known small in G's niche.
 * Editá libremente. Si un slug rompe, abrí la careers page real y mirá la URL.
 *
 * Verificar slug:
 *   greenhouse:      https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
 *   lever:           https://api.lever.co/v0/postings/{slug}
 *   ashby:           https://api.ashbyhq.com/posting-api/job-board/{slug}
 *   smartrecruiters: https://api.smartrecruiters.com/v1/companies/{slug}/postings
 *   workable:        https://apply.workable.com/api/v1/widget/accounts/{slug}
 *   personio:        https://{slug}.jobs.personio.de/xml
 *   teamtailor:      https://{slug}.teamtailor.com/jobs.json
 */

import type { Company } from './sources/index.ts'

// Companies pequeñas pero conocidas en el nicho design-eng/AI/dev tools.
export const KNOWN_SMALL_COMPANIES = [
  'Hevy',
  'Linear',
  'Resend',
  'Liveblocks',
  'Cal.com',
  'Penpot',
  'Tempo',
  'Magic Patterns',
  'v0',
  'Builder.io',
]

export const companies: Company[] = [
  // ========== Greenhouse (US-centric pero muchas tier 1 con EU presence) ==========
  { name: 'Miro', ats: 'greenhouse', slug: 'miro' },
  { name: 'Datadog', ats: 'greenhouse', slug: 'datadog', notes: 'oficina Madrid' },
  { name: 'TravelPerk', ats: 'greenhouse', slug: 'travelperk', notes: 'Barcelona HQ' },
  { name: 'Typeform', ats: 'greenhouse', slug: 'typeform', notes: 'Barcelona' },
  { name: 'Glovo', ats: 'greenhouse', slug: 'glovoapp', notes: 'Barcelona' },
  { name: 'N26', ats: 'greenhouse', slug: 'n26' },
  { name: 'Pleo', ats: 'greenhouse', slug: 'pleotechnologies' },
  { name: 'Contentful', ats: 'greenhouse', slug: 'contentful' },
  { name: 'Anthropic', ats: 'greenhouse', slug: 'anthropic' },
  { name: 'Wise', ats: 'greenhouse', slug: 'wise' },
  { name: 'DeepL', ats: 'greenhouse', slug: 'deepl' },

  // ========== Lever ==========
  { name: 'Hugging Face', ats: 'lever', slug: 'huggingface' },
  { name: 'Hevy', ats: 'lever', slug: 'hevy', notes: 'fitness app que G usa' },

  // ========== Ashby (AI-native, design-eng, dev tools) ==========
  { name: 'Mistral AI', ats: 'ashby', slug: 'mistral' },
  { name: 'Linear', ats: 'ashby', slug: 'linear', notes: 'design-eng culture' },
  { name: 'Resend', ats: 'ashby', slug: 'resend', notes: 'dev tool conocida' },
  { name: 'Cal.com', ats: 'ashby', slug: 'cal', notes: 'open source, conocida' },
  { name: 'Liveblocks', ats: 'ashby', slug: 'liveblocks', notes: 'collaboration infra' },

  // ========== SmartRecruiters (consultoras grandes + enterprise EU) ==========
  { name: 'NTT DATA Europe', ats: 'smartrecruiters', slug: 'nttdataeurope', notes: 'verificar slug' },
  { name: 'Capgemini', ats: 'smartrecruiters', slug: 'capgemini', notes: 'verificar slug' },
  // Más consultoras grandes a verificar manualmente cuando G las encuentre

  // ========== Workable (scale-ups EU, especialmente España) ==========
  // Note: agregar slugs cuando G encuentre companies de su interés que usen Workable.
  // Para verificar: careers page suele estar en apply.workable.com/{slug}
  // Placeholder - verificar antes de usar:
  // { name: 'CompanyX', ats: 'workable', slug: 'companyx' },

  // ========== Personio (DACH + algunas EU south) ==========
  { name: 'Personio', ats: 'personio', slug: 'personio', notes: 'el ATS mismo' },
  // Note: muchas DACH startups usan Personio. Verificar slugs cuando G las identifique.

  // ========== TeamTailor (Nordics + Spain/Portugal) ==========
  // Note: agregar slugs cuando G identifique companies que usen TeamTailor

  // ========== Pendientes de adapter custom (no usan estos ATS) ==========
  // GitLab, Stripe, Factorial, Bending Spoons, Vercel, Figma
  // Estos requieren scraping de careers pages propias - skip por ahora.
]

// Helper: lista de companies por ATS para debugging
export const companiesByATS = (): Record<string, number> =>
  companies.reduce((acc, c) => {
    acc[c.ats] = (acc[c.ats] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)
