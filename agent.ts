/**
 * agent.ts
 *
 * Pipeline orquestador. Las sources viven en sources/ (modular).
 *
 * Flujo:
 *   fetch (paralelo) → normalize → dedupe vs state → hard filters
 *   → triage GPT → deep enrich GPT (solo top) → save state
 *
 * Run: bun agent.ts | node --experimental-strip-types agent.ts
 *
 * Envs: OPENAI_API_KEY
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { companies, KNOWN_SMALL_COMPANIES } from './companies.ts'
import { atsAdapters } from './sources/index.ts'
import { fetchAdzuna } from './sources/search-adzuna.ts'
import { fetchLinkedInAlerts } from './sources/email-linkedin.ts'
import { sendJobsDigest } from './agent/notifications/email-digest.ts'
import type { Job, RawJob, ATS } from './sources/index.ts'
import type { Company } from './types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- types ----------

export type TriageResult = {
  fitScore: number
  matchType: 'direct' | 'stretch' | 'reach' | 'skip'
  reason: string
}

type EnrichedJob = Job &
  TriageResult & {
    redFlags: string[]
    whyMatch: string
    hiddenMatch: string | null
    outreach: string | null
    enrichmentLevel: 'triage' | 'deep'
  }

type EvalCandidate = {
  id: string
  company: string
  title: string
  location: string
  url: string
  description: string
  source: ATS
  status: 'ready_for_label' | 'needs_description'
  predicted: {
    fitScore: number
    matchType: 'direct' | 'stretch' | 'reach' | 'skip'
    reason: string
    enrichmentLevel: 'triage' | 'deep' | 'linkedin_pretriage'
    redFlags: string[]
    greenFlags?: string[]
    hiddenMatch: string | null
  }
  label: null
  expectedScore: null
  expectedMatchType: null
  notes: string
  capturedAt: string
}

type SourceHealth = {
  company: string
  ats: Company['ats']
  slug: string
  status: 'ok' | 'error'
  jobCount?: number
  error?: string
  applicationLink: {
    url: string
    kind: 'careers' | 'search'
  }
}

type SourceHealthReport = {
  generatedAt: string
  sources: SourceHealth[]
}

// ---------- config ----------

const models = {
  triage: 'gpt-4.1-mini',
  deep: 'gpt-4.1',
}

const DEEP_ENRICH_THRESHOLD = 7
const MAX_JOBS_PER_RUN = 50

// ---------- filters (regex, free) ----------

const NON_TECH_TITLE = new RegExp(
  [
    'sales',
    'marketing',
    'recruit',
    'hr\\b',
    'people ops',
    'customer success',
    'account exec',
    'account manager',
    'business develop',
    'finance',
    'legal',
    'compliance',
    'operations manager',
    'office manager',
    'executive assistant',
    'product manager',
    'product owner',
    'scrum master',
    'project manager',
    'designer\\b',
    'ux researcher',
    'data analyst',
    'data scientist',
    'analytics',
    'devops',
    'sre\\b',
    'security eng',
    'qa eng',
    'test eng',
    'mobile eng',
    'ios eng',
    'android eng',
    'backend eng',
    'data eng',
    'ml eng',
    'machine learning eng',
  ].join('|'),
  'i',
)

const TECH_SIGNALS = [
  /\breact\b/i,
  /\bpreact\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bvue\b/i,
  /\bsvelte\b/i,
  /\bnext\.?js\b/i,
  /\bnode\.?js\b/i,
  /design system/i,
  /component library/i,
  /\bfigma\b/i,
  /\bgsap\b/i,
  /accessibility|wcag|a11y/i,
  /front.?end/i,
  /fullstack|full.stack/i,
  /web (app|application|platform)/i,
  /\bui\b|user interface/i,
  /\bllm\b|generative ai|ai agent|copilot/i,
  /headless cms|drupal|contentful|sanity|strapi/i,
]
const MIN_SIGNALS = 2

const filters: Record<string, (j: RawJob) => boolean> = {
  notNonTech: (j) => !NON_TECH_TITLE.test(j.title),
  notJunior: (j) =>
    !/junior|jr\.?|\bintern\b|trainee|becari|practica|graduate|entry.level/i.test(j.title),
  hasTechSignals: (j) =>
    TECH_SIGNALS.filter((rx) => rx.test(`${j.title} ${j.description}`)).length >= MIN_SIGNALS,
  locationFit: (j) => {
    const loc = j.location.toLowerCase()
    return (
      loc.includes('barcelona') ||
      /remote|remoto/.test(loc) ||
      /spain|españa|espana/.test(loc) ||
      /europe|\beu\b|emea/.test(loc) ||
      loc === ''
    )
  },
}

export const passesFilters = (j: RawJob): boolean => Object.values(filters).every((f) => f(j))

export const preTriageLinkedInJob = (job: Job): EvalCandidate | null => {
  const haystack = `${job.title} ${job.company} ${job.location}`.toLowerCase()
  const redFlags: string[] = []
  const greenFlags: string[] = []

  const greenRules: Record<string, RegExp> = {
    seniorFrontend: /\bsenior\b.*\b(frontend|front-end|react|ui)\b|\b(frontend|front-end|react|ui)\b.*\bsenior\b/i,
    frontendRole: /\bfrontend\b|\bfront-end\b|\bfronted\b|\bui engineer\b/i,
    reactTypescript: /\breact\b|\btypescript\b|\btype\s?script\b/i,
    fullstackStretch: /\bfull[ -]?stack\b|\bproduct engineer\b|\bsoftware engineer\b/i,
    locationFit: /\bbarcelona\b|\bspain\b|\bremote\b|\bremoto\b|\beuropean union\b|\beu\b/i,
  }
  const redRules: Record<string, RegExp> = {
    aggregator: /\bjobgether\b|\bjoin\b|\bremote job\b/i,
    staffingLikely: /\bexperis\b|\bexperience it\b|\boes[ií]a\b|\bgrupo oes[ií]a\b/i,
    designerFirst: /\bproduct designer\b|\bux\b|\bui designer\b/i,
    junior: /\bjunior\b|\bintern\b|\btrainee\b/i,
    languageMismatch: /\bfrench\b|\bfrance\b|\bfranc[eé]s\b|\bfrancia\b/i,
  }

  Object.entries(greenRules).forEach(([name, rx]) => {
    if (rx.test(haystack)) greenFlags.push(name)
  })
  Object.entries(redRules).forEach(([name, rx]) => {
    if (rx.test(haystack)) redFlags.push(name)
  })

  if (redFlags.includes('junior') || redFlags.includes('languageMismatch')) return null
  if (greenFlags.length < 2 && !greenFlags.includes('seniorFrontend')) return null

  const fitScore = Math.max(4, Math.min(7, 4 + greenFlags.length - Math.min(redFlags.length, 2)))
  if (fitScore < 5) return null

  const matchType = greenFlags.includes('fullstackStretch') ? 'stretch' : 'direct'
  const reason =
    redFlags.length > 0
      ? 'Promising LinkedIn card, but needs description because there are company/source red flags.'
      : 'Promising LinkedIn card; needs description before real scoring.'

  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    description: job.description,
    source: job.source,
    status: 'needs_description',
    predicted: {
      fitScore,
      matchType,
      reason,
      enrichmentLevel: 'linkedin_pretriage',
      redFlags,
      greenFlags,
      hiddenMatch: null,
    },
    label: null,
    expectedScore: null,
    expectedMatchType: null,
    notes: 'LinkedIn email alert only. Open link and paste description if worth evaluating.',
    capturedAt: new Date().toISOString(),
  }
}

// ---------- state ----------

const STATE_PATH = path.join(__dirname, 'state.json')
const EVAL_CANDIDATES_PATH = path.join(__dirname, 'eval/candidates.json')
const SOURCE_HEALTH_PATH = path.join(__dirname, 'runs/latest-source-health.json')

const applicationLink = (
  company: Company,
): {
  url: string
  kind: 'careers' | 'search'
} =>
  company.careersUrl
    ? { url: company.careersUrl, kind: 'careers' }
    : {
        url: `https://www.google.com/search?q=${encodeURIComponent(`${company.name} careers jobs`)}`,
        kind: 'search',
      }

const loadState = async (): Promise<Set<string>> => {
  try {
    return new Set(JSON.parse(await fs.readFile(STATE_PATH, 'utf-8')))
  } catch {
    return new Set()
  }
}

const saveState = (seen: Set<string>) =>
  fs.writeFile(STATE_PATH, JSON.stringify([...seen], null, 2))

const saveEvalCandidates = async (candidates: EvalCandidate[]) => {
  if (candidates.length === 0) return

  const existing = await fs
    .readFile(EVAL_CANDIDATES_PATH, 'utf-8')
    .then((text) => JSON.parse(text) as EvalCandidate[])
    .catch(() => [])
  const seenIds = new Set(existing.map((entry) => entry.id))
  const next = [...existing, ...candidates.filter((candidate) => !seenIds.has(candidate.id))]

  await fs.mkdir(path.dirname(EVAL_CANDIDATES_PATH), { recursive: true })
  await fs.writeFile(EVAL_CANDIDATES_PATH, JSON.stringify(next, null, 2))
}

const enrichedToEvalCandidate = (job: EnrichedJob): EvalCandidate => ({
  id: job.id,
  company: job.company,
  title: job.title,
  location: job.location,
  url: job.url,
  description: job.description,
  source: job.source,
  status: 'ready_for_label',
  predicted: {
    fitScore: job.fitScore,
    matchType: job.matchType,
    reason: job.reason,
    enrichmentLevel: job.enrichmentLevel,
    redFlags: job.redFlags,
    hiddenMatch: job.hiddenMatch,
  },
  label: null,
  expectedScore: null,
  expectedMatchType: null,
  notes: '',
  capturedAt: new Date().toISOString(),
})

// ---------- enrichment ----------

const PROFILE = `
G - Senior Frontend Engineer, Barcelona.

WHAT HER CV SAYS (visible):
- Stack: React/Preact, TypeScript, GSAP, design systems, Figma
- Title: Senior Frontend Engineer
- Background: multimedia/graphic design + systems engineering studies

WHAT SHE ACTUALLY DOES (often NOT visible on CV — STRETCH MATCHES):
- Fullstack work: comfortable with Node, API design, schema contracts
- Production AI agent implementation (top 10-15% of FE practitioners globally)
- AI-assisted workflows: Copilot agents, Figma Code Connect, Plan→Execute→Validate
- Design engineering: lives at design-dev boundary, builds Figma plugins (WAVE)
- Product thinking: cross-team architecture, has soft-lead responsibilities
- Cross-team leadership: coordinates frontend + Drupal/CMS + design teams
- Accessibility expertise: WCAG/ARIA, focus management, audit fixes
- Drupal/headless CMS experience (current role)
- Prior fintech/crypto experience (2021-2022)
- Public speaking: 45-min conference talk on AI workflows
- Spanish native, English fluent

LOCATION: Barcelona hybrid OR Spain/EU remote.
RATE/SALARY: 55k EUR/yr piso.
LONG-TERM GOAL: tech team leadership.

COMPANY PREFERENCE:
- Open to: large companies (100+), scale-ups, big-name consultancies, AND notable small companies in design-eng / AI tooling space.
- Big consultancies OK if recognizable (Capgemini, Accenture, Randstad Digital, NTT Data, Agap2).
- NOT interested in: random small startups, body-shops chicos sin nombre.
- Known-good small companies (always pass): ${KNOWN_SMALL_COMPANIES.join(', ')}.

CRITICAL FOR THE AGENT:
G is too narrow in her self-presentation. CV says "frontend" but she does fullstack, product, AI integration, design ownership. Surface stretch matches aggressively.
`.trim()

const extractResponseText = (data: any): string => {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }

  const textParts =
    data.output
      ?.flatMap((item: any) => item.content ?? [])
      ?.filter((part: any) => part.type === 'output_text' && typeof part.text === 'string')
      ?.map((part: any) => part.text.trim())
      ?.filter(Boolean) ?? []

  if (textParts.length > 0) return textParts.join('\n')

  throw new Error('OpenAI response did not include text output')
}

const callOpenAI = async (
  model: string,
  prompt: string,
  apiKey: string,
  maxOutputTokens: number,
  schemaName: string,
  schema: Record<string, unknown>,
): Promise<string> => {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: maxOutputTokens,
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          schema,
        },
      },
    }),
  })
  if (!r.ok) throw new Error(`${model}: ${r.status} ${await r.text()}`)
  return extractResponseText(await r.json())
}

export const triageJob = async (job: Job, apiKey: string): Promise<TriageResult> => {
  const prompt = `Quick classification task. Be fast and decisive.

CANDIDATE: Senior Frontend Engineer, Barcelona. Stack: React/Preact/TS/GSAP/design systems/Figma. Differentiator: production AI agent experience. Also does (but doesn't advertise): fullstack, product eng, design eng, accessibility, headless CMS.
WANTS: Barcelona hybrid or Spain/EU remote. Tier 1-2 companies, big-name consultancies OK, OR known small companies in design-eng/dev tools/AI.
TIER 1 (Google/Stripe/Anthropic/Datadog/Figma/Miro/big fintechs): "Engineer II"/L4 scores normally.

JOB:
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}
Description: ${job.description.slice(0, 2000)}

Return ONLY JSON, no preamble:
{
  "fitScore": <1-10 integer>,
  "matchType": "direct" | "stretch" | "reach" | "skip",
  "reason": "<one sentence, max 15 words>"
}

Scoring (decisive, not generous):
- 8-10: clear fit (direct OR stretch), good company tier, location OK
- 6-7: probable fit but some friction
- 3-5: weak fit
- 1-2: clear skip

Important calibration:
- Use 6-7 for interesting roles G should review herself but not obvious yes.
- If description is empty because the source is a LinkedIn email alert, do lightweight pre-triage from title/company/location only. Use 6-7 for promising "needs description" cards, not 8+.
- Do NOT score 8+ only because the post says AI, agentic, React, TypeScript, or remote.
- Penalize serious friction: office-heavy, elitist culture, crypto/Web3 core, small fragile startup, body-shop staffing, Ruby/Rails core, Java/Spring/Angular core, or backend/platform core where React is only a bonus.
- Enterprise AI roles with Java/Spring/Angular core are usually review-worthy maybes (5-6), not clear skips, when the company is strong and the work is genuinely AI/platform.
- Toptal-like talent marketplaces, "world-class IC/top 1%" language, and Ruby/Rails adjacency are culture/business-model red flags. These should usually score below 7 even if React/TS matches.
- Known consultancies (Agap2, Randstad Digital, NTT Data, Capgemini, Accenture, Capitole) are NOT automatic body-shops. If stack/location match, they can be 7.
- Spanish staffing/body-shop language such as "Analista Programador", BETWEEN-style benefits, or generic client work should usually score below 7 unless the consultancy is recognizable and the role is clearly frontend/React.
- Enterprise or retail platform frontend roles can be 7+ without AI if React/TypeScript, architecture, design systems, mentoring, performance, or Barcelona hybrid match. AI is a boost, not a requirement.
- Small startups can still be good, but only score 8+ if there are strong solidity signals: funding, known backers, clear traction, credible salary, or strategic niche fit.`

  const text = await callOpenAI(models.triage, prompt, apiKey, 200, 'triage_result', {
    type: 'object',
    additionalProperties: false,
    properties: {
      fitScore: { type: 'integer', minimum: 1, maximum: 10 },
      matchType: { type: 'string', enum: ['direct', 'stretch', 'reach', 'skip'] },
      reason: { type: 'string' },
    },
    required: ['fitScore', 'matchType', 'reason'],
  })
  return JSON.parse(text)
}

export const deepEnrich = async (
  job: Job,
  triage: TriageResult,
  apiKey: string,
): Promise<Omit<EnrichedJob, keyof Job | 'enrichmentLevel'>> => {
  const prompt = `Evaluating job for specific candidate. Triage already said: fitScore ${triage.fitScore}/${triage.matchType} because "${triage.reason}". Validate and deepen.

CANDIDATE PROFILE:
${PROFILE}

JOB POSTING:
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}
Department: ${job.department ?? 'n/a'}

Description:
${job.description.slice(0, 4000)}

CRITICAL: Evaluate based on DESCRIPTION, not title.

Return ONLY valid JSON:
{
  "fitScore": <integer 1-10, can adjust>,
  "matchType": "direct" | "stretch" | "reach",
  "redFlags": ["...", "..."],
  "whyMatch": "<2 sentences max, citing SPECIFIC phrases from description>",
  "hiddenMatch": "<MOST IMPORTANT. If role asks for things G does but doesn't lead with on CV (fullstack, product, AI integration, design ownership, accessibility, headless CMS, public speaking, cross-team coordination) — describe EXACTLY what to mention. Quote relevant phrase from description. Be specific to her actual experience. If nothing hidden, return null.>",
  "outreach": "<3-sentence DM to engineering lead, English, referencing SPECIFIC description content AND leveraging hiddenMatch if exists.>"
}

Match types:
- "direct": description matches CV
- "stretch": GOLD - asks for things she does but CV undersells
- "reach": requires genuine new learning

Tier-aware seniority:
- Tier 1: "Engineer II"/L4 OK (comp is senior-band)
- Tier 2: prefer senior title
- Tier 3 unknown small: cap at 4 unless in known-good list

Find what G WOULDN'T find scanning titles herself.`

  const text = await callOpenAI(models.deep, prompt, apiKey, 700, 'deep_enrichment', {
    type: 'object',
    additionalProperties: false,
    properties: {
      fitScore: { type: 'integer', minimum: 1, maximum: 10 },
      matchType: { type: 'string', enum: ['direct', 'stretch', 'reach'] },
      redFlags: { type: 'array', items: { type: 'string' } },
      whyMatch: { type: 'string' },
      hiddenMatch: { type: ['string', 'null'] },
      outreach: { type: ['string', 'null'] },
    },
    required: ['fitScore', 'matchType', 'redFlags', 'whyMatch', 'hiddenMatch', 'outreach'],
  })
  return JSON.parse(text)
}

// ---------- pipeline ----------

async function run() {
  const openAIKey = process.env.OPENAI_API_KEY
  if (!openAIKey) {
    throw new Error('Falta env: OPENAI_API_KEY')
  }

  const seen = await loadState()
  console.error(`state: ${seen.size} seen jobs`)
  console.error(`companies: ${companies.length} across ${new Set(companies.map((c) => c.ats)).size} ATS`)

  // 1a. ATS sources (company-by-company)
  const results = await Promise.allSettled(
    companies.map(async (c): Promise<Job[]> => {
      const raw = await atsAdapters[c.ats](c.slug)
      console.error(`✓ ${c.name} (${c.ats}): ${raw.length}`)
      return raw.map((j) => ({ ...j, company: c.name, source: c.ats }))
    }),
  )
  const sourceHealth: SourceHealth[] = results.map((result, index) => {
    const company = companies[index]
    if (result.status === 'fulfilled') {
      return {
        company: company.name,
        ats: company.ats,
        slug: company.slug,
        status: 'ok',
        jobCount: result.value.length,
        applicationLink: applicationLink(company),
      }
    }

    return {
      company: company.name,
      ats: company.ats,
      slug: company.slug,
      status: 'error',
      error: String(result.reason),
      applicationLink: applicationLink(company),
    }
  })
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`✗ ${companies[i].name} (${companies[i].ats}): ${r.reason}`)
  })
  await fs.mkdir(path.dirname(SOURCE_HEALTH_PATH), { recursive: true })
  const sourceHealthReport: SourceHealthReport = {
    generatedAt: new Date().toISOString(),
    sources: sourceHealth,
  }
  await fs.writeFile(SOURCE_HEALTH_PATH, JSON.stringify(sourceHealthReport, null, 2))
  const allFromATS = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))

  // 1b. Adzuna search (solo 1x/día para preservar free tier 250 req/mes)
  // Trackeamos último run de Adzuna en un file separado.
  const ADZUNA_STATE = path.join(__dirname, '.adzuna-last-run')
  let allFromAdzuna: Job[] = []
  try {
    const lastRun = await fs.readFile(ADZUNA_STATE, 'utf-8').catch(() => '0')
    const hoursSinceLastRun = (Date.now() - parseInt(lastRun, 10)) / (1000 * 60 * 60)
    const forceAdzuna = process.env.FORCE_ADZUNA === '1' || process.argv.includes('--force-adzuna')

    if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
      console.error(`⏭  Adzuna skipped (missing ADZUNA_APP_ID / ADZUNA_APP_KEY)`)
    } else if (forceAdzuna || hoursSinceLastRun >= 20) {
      const adzunaJobs = await fetchAdzuna(
        process.env.ADZUNA_APP_ID,
        process.env.ADZUNA_APP_KEY,
      )
      // Cada Adzuna job tiene su propio "company" en el field, no es slug-based
      allFromAdzuna = adzunaJobs.map((j) => ({
        ...j,
        company: (j as any).company || 'Unknown',
        source: 'adzuna' as any, // marca explicit
      }))
      await fs.writeFile(ADZUNA_STATE, String(Date.now()))
      console.error(`✓ Adzuna search: ${allFromAdzuna.length}${forceAdzuna ? ' (forced)' : ''}`)
    } else {
      const next = (20 - hoursSinceLastRun).toFixed(1)
      console.error(`⏭  Adzuna skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago, next in ${next}h)`)
    }
  } catch (err) {
    console.error(`✗ Adzuna failed: ${(err as Error).message}`)
  }

  // 1c. LinkedIn email alerts (corre cada run, dedupe via state.json + Seen flag)
  let allFromLinkedIn: Job[] = []
  try {
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      const liJobs = await fetchLinkedInAlerts(
        process.env.GMAIL_USER,
        process.env.GMAIL_APP_PASSWORD,
      )
      allFromLinkedIn = liJobs.map((j) => ({
        ...j,
        source: 'linkedin' as any,
      }))
      console.error(`✓ LinkedIn emails: ${allFromLinkedIn.length}`)
    } else {
      console.error(`⏭  LinkedIn email skipped (no GMAIL_* envs)`)
    }
  } catch (err) {
    console.error(`✗ LinkedIn email failed: ${(err as Error).message}`)
  }

  const allJobs = [...allFromATS, ...allFromAdzuna, ...allFromLinkedIn]
  console.error(`\nTotal fetched: ${allJobs.length} (${allFromATS.length} ATS + ${allFromAdzuna.length} Adzuna + ${allFromLinkedIn.length} LinkedIn)`)

  // 2. filter + dedupe. LinkedIn email cards usually have no description, so they
  // go through a separate lightweight lane and are saved for manual description.
  const fresh = allJobs.filter(passesFilters).filter((j) => !seen.has(j.id))
  const linkedinNeedsDescription = fresh
    .filter((j) => j.source === 'linkedin' && j.description.trim() === '')
    .map(preTriageLinkedInJob)
    .filter((candidate): candidate is EvalCandidate => candidate !== null)
  const freshRunnable = fresh.filter((j) => !(j.source === 'linkedin' && j.description.trim() === ''))

  console.error(`\nfresh after filter+dedupe: ${fresh.length} / ${allJobs.length}`)
  console.error(`LinkedIn needs description: ${linkedinNeedsDescription.length}`)
  console.error(`fresh runnable for GPT: ${freshRunnable.length}`)

  // 3. cascada triage → deep
  const enriched: EnrichedJob[] = []
  let triageCount = 0
  let deepCount = 0

  for (const job of freshRunnable.slice(0, MAX_JOBS_PER_RUN)) {
    try {
      const triage = await triageJob(job, openAIKey)
      triageCount++
      console.error(`  triage ${triage.fitScore}/10 ${triage.matchType} - ${job.company} / ${job.title}`)

      if (triage.fitScore >= DEEP_ENRICH_THRESHOLD && triage.matchType !== 'skip') {
        const deep = await deepEnrich(job, triage, openAIKey)
        deepCount++
        enriched.push({
          ...job,
          ...deep,
          reason: triage.reason,
          enrichmentLevel: 'deep',
        })
        console.error(`    ↳ deep ${deep.fitScore}/10 ${deep.matchType}`)
      } else {
        enriched.push({
          ...job,
          ...triage,
          redFlags: [],
          whyMatch: triage.reason,
          hiddenMatch: null,
          outreach: null,
          enrichmentLevel: 'triage',
        })
      }
    } catch (err) {
      console.error(`enrich failed: ${job.company} / ${job.title}: ${(err as Error).message}`)
    }
  }
  console.error(`\nLLM calls: ${triageCount} triage (${models.triage}) + ${deepCount} deep (${models.deep})`)

  // 4. select top matches
  const top = enriched
    .filter((e) => e.enrichmentLevel === 'deep' && e.fitScore >= 7)
    .sort((a, b) => b.fitScore - a.fitScore)
  console.error(`top matches ready: ${top.length} (notification disabled; email pending)`)

  // 5. save state
  fresh.forEach((j) => seen.add(j.id))
  await saveState(seen)

  // 6. archivo del run
  await fs.mkdir(path.join(__dirname, 'runs'), { recursive: true })
  await fs.writeFile(
    path.join(__dirname, `runs/${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify(enriched, null, 2),
  )
  await saveEvalCandidates([
    ...enriched.map(enrichedToEvalCandidate),
    ...linkedinNeedsDescription,
  ])

  try {
    const digestResult = await sendJobsDigest({
      topMatches: top,
      needsDescription: linkedinNeedsDescription,
      gmailUser: process.env.GMAIL_USER ?? '',
      gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? '',
      to: process.env.JOBS_DIGEST_EMAIL_TO ?? process.env.GMAIL_USER,
    })
    if (digestResult.sent) {
      console.error(`✓ Email digest sent to ${digestResult.to}`)
    } else {
      console.error(`⏭  Email digest skipped (${digestResult.reason})`)
    }
  } catch (err) {
    console.error(`✗ Email digest failed: ${(err as Error).message}`)
  }

  console.error(`done. top ready: ${top.length}`)
}

if (import.meta.main) {
  run().catch((e) => {
    console.error('FATAL:', e)
    process.exit(1)
  })
}
