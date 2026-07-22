import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { deepEnrich, triageJob } from '../agent.ts'
import type { Job } from '../types.ts'
import type { GoldenCase, GoldenSet, Label, MatchType } from '../eval/types.ts'

type Candidate = {
  id: string
  company: string
  title: string
  location: string
  url: string
  description: string
  source: Job['source'] | 'manual'
  status: 'ready_for_label' | 'needs_description' | 'scored'
  predicted: {
    fitScore: number
    matchType: MatchType
    reason: string
    enrichmentLevel: 'triage' | 'deep' | 'linkedin_pretriage'
    redFlags: string[]
    greenFlags?: string[]
    hiddenMatch: string | null
    whyMatch?: string
    outreach?: string | null
  }
  label: null | Label
  expectedScore: null | number
  expectedMatchType: null | MatchType
  notes: string
  outcome?: string
  outcomeNotes?: string
  capturedAt: string
  scoredAt?: string
}

type SourceHealth = {
  company: string
  ats: Job['source']
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

type DashboardLane = 'traction' | 'active' | 'closed' | 'backlog'

type DashboardInsight = {
  label: string
  count: number
}

type DashboardSpotlight = {
  id: string
  company: string
  title: string
  outcome: string
  lane: DashboardLane
  reason: string
}

type DashboardSnapshot = {
  summary: Record<DashboardLane | 'tracked', number>
  working: DashboardInsight[]
  stalled: DashboardInsight[]
  spotlight: DashboardSpotlight[]
}

const ROOT = path.join(import.meta.dirname, '..')
const CANDIDATES_PATH = path.join(ROOT, 'eval/candidates.json')
const GOLDEN_PATH = path.join(ROOT, 'eval/golden.json')
const SOURCE_HEALTH_PATH = path.join(ROOT, 'runs/latest-source-health.json')
const DEEP_THRESHOLD = 7
let agentRun:
  | {
      running: boolean
      startedAt: string
      finishedAt?: string
      exitCode?: number
      forceAdzuna: boolean
      output: string
    }
  | null = null

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const readJsonBody = async <T>(request: Request): Promise<T> => {
  try {
    return (await request.json()) as T
  } catch {
    throw new Error('Invalid JSON body')
  }
}

const loadCandidates = async (): Promise<Candidate[]> =>
  JSON.parse(await fs.readFile(CANDIDATES_PATH, 'utf-8')) as Candidate[]

const saveCandidates = async (candidates: Candidate[]) =>
  fs.writeFile(CANDIDATES_PATH, JSON.stringify(candidates, null, 2))

const loadGolden = async (): Promise<GoldenSet> =>
  JSON.parse(await fs.readFile(GOLDEN_PATH, 'utf-8')) as GoldenSet

const saveGolden = async (golden: GoldenSet) =>
  fs.writeFile(GOLDEN_PATH, JSON.stringify(golden, null, 2))

const loadSourceHealth = async (): Promise<SourceHealthReport> =>
  fs
    .readFile(SOURCE_HEALTH_PATH, 'utf-8')
    .then((text) => JSON.parse(text) as SourceHealthReport)
    .catch(() => ({
      generatedAt: '',
      sources: [],
    }))

const parseLabel = (value: unknown): Label => {
  if (value === 'yes' || value === 'no' || value === 'maybe') return value
  throw new Error('label must be yes | no | maybe')
}

const parseMatchType = (value: unknown): MatchType => {
  if (value === 'direct' || value === 'stretch' || value === 'reach' || value === 'skip') {
    return value
  }
  throw new Error('matchType must be direct | stretch | reach | skip')
}

const parseScore = (value: unknown): number => {
  const score = Number(value)
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error('score must be an integer from 1 to 10')
  }
  return score
}

const normalizeOutcome = (value?: string | null) => value?.trim().toLowerCase().replaceAll(/[\s-]+/g, '_') ?? ''

const classifyOutcomeLane = (value?: string | null): DashboardLane => {
  const outcome = normalizeOutcome(value)

  if (!outcome) return 'backlog'
  if (outcome === 'interviewing' || outcome === 'reached_final_interview') return 'traction'
  if (outcome === 'applied' || outcome === 'interested') return 'active'
  if (outcome === 'rejected' || outcome === 'ghosted' || outcome === 'not_interested') return 'closed'

  if (
    /reached_final_interview|advanced_to_interview|advanced_then_|recruiter_reached_out/.test(outcome)
  ) {
    return 'traction'
  }

  if (
    /applied_pending_response|applied_no_response|applied_viewed_silent|application_status_unknown/.test(
      outcome,
    )
  ) {
    return 'active'
  }

  if (
    /silent_rejection|template_rejection|ghost|role_filled|contacted_g_said_no|mutual_no_fit|withdrew/.test(
      outcome,
    )
  ) {
    return 'closed'
  }

  return 'backlog'
}

const inferFailureTags = (reason: string, outcome: string, redFlags: string[]) => {
  const text = `${reason} ${outcome} ${redFlags.join(' ')}`.toLowerCase()
  const tags: string[] = []

  if (/java|spring|angular/.test(text)) tags.push('Java / Angular pivot')
  if (/ruby|rails/.test(text)) tags.push('Ruby / Rails adjacency')
  if (/body-shop|staffing|contractor|consultora chica/.test(text)) tags.push('Body-shop or contractor model')
  if (/startup chica|small|fragile|tier 3/.test(text)) tags.push('Fragile small-company risk')
  if (/office|70% oficina|80% office/.test(text)) tags.push('Office-heavy setup')
  if (/france|germany|north america|location/.test(text)) tags.push('Location mismatch')
  if (/template|silent|no_response|ghost/.test(text)) tags.push('Cold application response gap')

  return tags
}

const inferSuccessTags = (reason: string, greenFlags: string[]) => {
  const text = `${reason} ${greenFlags.join(' ')}`.toLowerCase()
  const tags: string[] = []

  if (/barcelona|hybrid/.test(text)) tags.push('Barcelona hybrid still converts')
  if (/ai|agentic/.test(text)) tags.push('AI-first teams get traction')
  if (/consultora|fortune 500|knownconsultancy/.test(text)) tags.push('Known consultancies can work')
  if (/designsystems|design system|storybook/.test(text)) tags.push('Design systems stay valuable')
  if (/react|typescript|stackmatchreacttsnode/.test(text)) tags.push('Exact React + TS fit matters')

  return tags
}

const topInsights = (values: string[]) =>
  [...values.reduce((acc, value) => acc.set(value, (acc.get(value) ?? 0) + 1), new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }))

const buildDashboard = (candidates: Candidate[], golden: GoldenSet): DashboardSnapshot => {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const tracked = new Map<
    string,
    {
      id: string
      company: string
      title: string
      outcome: string
      reason: string
      lane: DashboardLane
      greenFlags: string[]
      redFlags: string[]
      capturedAt?: string
    }
  >()

  golden.cases.forEach((entry) => {
    const candidate = candidateById.get(entry.id)
    const outcome = entry.outcome ?? candidate?.outcome ?? ''
    tracked.set(entry.id, {
      id: entry.id,
      company: entry.company,
      title: entry.title,
      outcome,
      reason: entry.reason ?? candidate?.notes ?? '',
      lane: classifyOutcomeLane(outcome),
      greenFlags: entry.greenFlags ?? candidate?.predicted.greenFlags ?? [],
      redFlags: entry.redFlags ?? candidate?.predicted.redFlags ?? [],
      capturedAt: candidate?.capturedAt,
    })
  })

  candidates.forEach((candidate) => {
    if (tracked.has(candidate.id)) return

    const likelyRelevant =
      Boolean(candidate.outcome) ||
      candidate.label === 'yes' ||
      candidate.predicted.fitScore >= 7 ||
      candidate.status === 'needs_description'

    if (!likelyRelevant) return

    tracked.set(candidate.id, {
      id: candidate.id,
      company: candidate.company,
      title: candidate.title,
      outcome: candidate.outcome ?? '',
      reason: candidate.outcomeNotes?.trim() || candidate.notes || candidate.predicted.reason,
      lane: classifyOutcomeLane(candidate.outcome),
      greenFlags: candidate.predicted.greenFlags ?? [],
      redFlags: candidate.predicted.redFlags ?? [],
      capturedAt: candidate.capturedAt,
    })
  })

  const rows = [...tracked.values()]
  const summary = rows.reduce(
    (acc, row) => {
      acc[row.lane] += 1
      return acc
    },
    { tracked: rows.length, traction: 0, active: 0, closed: 0, backlog: 0 } satisfies Record<
      DashboardLane | 'tracked',
      number
    >,
  )

  const working = topInsights(
    rows
      .filter((row) => row.lane === 'traction')
      .flatMap((row) => inferSuccessTags(row.reason, row.greenFlags)),
  )

  const stalled = topInsights(
    rows
      .filter((row) => row.lane === 'closed')
      .flatMap((row) => inferFailureTags(row.reason, row.outcome, row.redFlags)),
  )

  const laneOrder: Record<DashboardLane, number> = {
    traction: 0,
    active: 1,
    backlog: 2,
    closed: 3,
  }

  const spotlight = rows
    .sort((a, b) => {
      const laneDelta = laneOrder[a.lane] - laneOrder[b.lane]
      if (laneDelta !== 0) return laneDelta
      return (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '')
    })
    .slice(0, 6)
    .map((row) => ({
      id: row.id,
      company: row.company,
      title: row.title,
      outcome: row.outcome || 'not tracked yet',
      lane: row.lane,
      reason: row.reason,
    }))

  return { summary, working, stalled, spotlight }
}

const suggestedLabelFor = (candidate: Candidate) => {
  const score = candidate.predicted.fitScore
  const redFlags = candidate.predicted.redFlags ?? []
  const title = candidate.title.toLowerCase()
  const company = candidate.company.toLowerCase()

  if (
    redFlags.some((flag) => ['salaryBelowFloor', 'languageMismatch', 'locationMismatch'].includes(flag)) ||
    /freelance|shopify|angular|\bjava\b|\.net|backend/.test(title)
  ) {
    return {
      label: 'no' as Label,
      score: Math.min(score, 5),
      matchType: candidate.predicted.matchType,
      confidence: 'medium',
      reason: 'Hard friction/red flag despite some surface match.',
    }
  }

  if (/bairesdev|the white team|experience it|plexus|sopra|irium|gfi|cas training/.test(company)) {
    return {
      label: 'maybe' as Label,
      score: Math.min(score, 6),
      matchType: candidate.predicted.matchType,
      confidence: 'low',
      reason: 'Consultancy/staffing-ish source; needs human preference check.',
    }
  }

  if (score >= 8) {
    return {
      label: 'yes' as Label,
      score,
      matchType: candidate.predicted.matchType,
      confidence: 'medium',
      reason: 'High predicted score with strong fit signals.',
    }
  }

  if (score >= 6) {
    return {
      label: 'maybe' as Label,
      score,
      matchType: candidate.predicted.matchType,
      confidence: 'medium',
      reason: 'Review-worthy but not obvious yes.',
    }
  }

  return {
    label: 'no' as Label,
    score,
    matchType: candidate.predicted.matchType,
    confidence: 'medium',
    reason: 'Below review threshold.',
  }
}

const candidateToGoldenCase = ({
  candidate,
  label,
  expectedScore,
  expectedMatchType,
  reason,
}: {
  candidate: Candidate
  label: Label
  expectedScore: number
  expectedMatchType: MatchType
  reason: string
}): GoldenCase => ({
  id: candidate.id,
  company: candidate.company,
  title: candidate.title,
  location: candidate.location,
  url: candidate.url,
  description: candidate.description,
  label,
  expectedScore,
  expectedMatchType,
  reason,
  redFlags: candidate.predicted.redFlags ?? [],
  greenFlags: candidate.predicted.greenFlags ?? [],
  outcome: candidate.outcome?.trim() || 'promoted_from_admin',
  notes: candidate.notes,
})

const appendRunOutput = (chunk: string) => {
  if (!agentRun) return
  agentRun.output = `${agentRun.output}${chunk}`.slice(-20000)
}

const readStreamToRunOutput = async (stream: ReadableStream<Uint8Array> | null) => {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    appendRunOutput(decoder.decode(value))
  }
}

const runAgent = ({ forceAdzuna }: { forceAdzuna: boolean }) => {
  if (agentRun?.running) {
    return { ok: false, reason: 'Agent is already running.', run: agentRun }
  }

  agentRun = {
    running: true,
    startedAt: new Date().toISOString(),
    forceAdzuna,
    output: '',
  }

  const proc = Bun.spawn(['bun', 'agent.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(forceAdzuna ? { FORCE_ADZUNA: '1' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  void Promise.all([readStreamToRunOutput(proc.stdout), readStreamToRunOutput(proc.stderr)])
  void proc.exited.then((exitCode) => {
    if (!agentRun) return
    agentRun.running = false
    agentRun.finishedAt = new Date().toISOString()
    agentRun.exitCode = exitCode
  })

  return { ok: true, run: agentRun }
}

const getCandidatesPayload = async () => {
  const candidates = await loadCandidates()
  const golden = await loadGolden()
  const sourceHealth = await loadSourceHealth()
  const goldenIds = new Set(golden.cases.map((entry) => entry.id))
  const goldenById = new Map(golden.cases.map((entry) => [entry.id, entry]))
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const dashboard = buildDashboard(candidates, golden)

  const enrichedCandidates = candidates.map((candidate) => {
    const goldenCase = goldenById.get(candidate.id)
    const effectiveOutcome = candidate.outcome?.trim() || goldenCase?.outcome || ''
    const effectiveNotes = candidate.notes?.trim() || goldenCase?.reason || ''

    return {
      ...candidate,
      outcome: effectiveOutcome,
      notes: effectiveNotes,
      inGolden: goldenIds.has(candidate.id),
      journeyLane: classifyOutcomeLane(effectiveOutcome),
      suggestion: candidate.description.trim() ? suggestedLabelFor(candidate) : null,
    }
  })

  const historicalCandidates = golden.cases
    .filter((entry) => !candidateIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      company: entry.company,
      title: entry.title,
      location: entry.location,
      url: entry.url ?? '',
      description: entry.description ?? '',
      source: 'manual' as const,
      status: 'scored' as const,
      predicted: {
        fitScore: entry.expectedScore,
        matchType: entry.expectedMatchType,
        reason: entry.reason,
        enrichmentLevel: 'deep' as const,
        redFlags: entry.redFlags ?? [],
        greenFlags: entry.greenFlags ?? [],
        hiddenMatch: null,
      },
      label: entry.label,
      expectedScore: entry.expectedScore,
      expectedMatchType: entry.expectedMatchType,
      notes: entry.reason,
      outcome: entry.outcome ?? '',
      outcomeNotes: entry.notes ?? '',
      capturedAt: '',
      scoredAt: '',
      inGolden: true,
      journeyLane: classifyOutcomeLane(entry.outcome),
      suggestion: null,
    }))

  const enriched = [...enrichedCandidates, ...historicalCandidates]

  return {
    counts: {
      total: enriched.length,
      ready: enriched.filter((candidate) => candidate.description.trim()).length,
      needsDescription: enriched.filter((candidate) => candidate.status === 'needs_description').length,
      labeled: enriched.filter((candidate) => candidate.label).length,
      golden: golden.cases.length,
    },
    candidates: enriched.sort((a, b) => {
      if (a.status === 'needs_description' && b.status !== 'needs_description') return 1
      if (a.status !== 'needs_description' && b.status === 'needs_description') return -1
      return b.predicted.fitScore - a.predicted.fitScore
    }),
    dashboard,
    sourceHealth,
  }
}

const labelCandidate = async (body: {
  id?: string
  label?: unknown
  score?: unknown
  matchType?: unknown
  reason?: string
  outcome?: string
  outcomeNotes?: string
}) => {
  if (!body.id) throw new Error('Missing candidate id')
  const label = parseLabel(body.label)
  const expectedScore = parseScore(body.score)
  const expectedMatchType = parseMatchType(body.matchType)
  const reason = body.reason?.trim()
  if (!reason) throw new Error('Missing reason')

  const candidates = await loadCandidates()
  const index = candidates.findIndex((candidate) => candidate.id === body.id)
  if (index === -1) throw new Error(`Unknown candidate: ${body.id}`)
  if (!candidates[index].description.trim()) {
    throw new Error('Candidate needs description before it can become golden.')
  }

  candidates[index] = {
    ...candidates[index],
    label,
    expectedScore,
    expectedMatchType,
    notes: reason,
    outcome: body.outcome?.trim() || candidates[index].outcome,
    outcomeNotes: body.outcomeNotes?.trim() || candidates[index].outcomeNotes,
  }

  const golden = await loadGolden()
  const goldenCase = candidateToGoldenCase({
    candidate: candidates[index],
    label,
    expectedScore,
    expectedMatchType,
    reason,
  })
  const goldenIndex = golden.cases.findIndex((entry) => entry.id === body.id)
  if (goldenIndex === -1) {
    golden.cases.push(goldenCase)
  } else {
    golden.cases[goldenIndex] = goldenCase
  }

  await saveCandidates(candidates)
  await saveGolden(golden)

  return { ok: true, candidate: candidates[index], goldenCases: golden.cases.length }
}

const saveOutcome = async (body: {
  id?: string
  outcome?: string
  outcomeNotes?: string
}) => {
  if (!body.id) throw new Error('Missing candidate id')
  const candidates = await loadCandidates()
  const index = candidates.findIndex((candidate) => candidate.id === body.id)
  if (index === -1) throw new Error(`Unknown candidate: ${body.id}`)

  candidates[index] = {
    ...candidates[index],
    outcome: body.outcome?.trim() || '',
    outcomeNotes: body.outcomeNotes?.trim() || '',
  }

  await saveCandidates(candidates)
  return { ok: true, candidate: candidates[index] }
}

const scoreCandidate = async (body: { id?: string; description?: string }) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
  if (!body.id) throw new Error('Missing candidate id')
  const description = body.description?.trim()
  if (!description) throw new Error('Missing description')

  const candidates = await loadCandidates()
  const index = candidates.findIndex((candidate) => candidate.id === body.id)
  if (index === -1) throw new Error(`Unknown candidate: ${body.id}`)

  const candidate = candidates[index]
  const job: Job = {
    id: candidate.id,
    company: candidate.company,
    title: candidate.title,
    location: candidate.location,
    url: candidate.url,
    source: candidate.source,
    postedAt: candidate.capturedAt,
    description,
  }

  const triage = await triageJob(job, apiKey)
  const deep =
    triage.fitScore >= DEEP_THRESHOLD && triage.matchType !== 'skip'
      ? await deepEnrich(job, triage, apiKey)
      : null

  candidates[index] = {
    ...candidate,
    description,
    status: 'scored',
    predicted: {
      fitScore: deep?.fitScore ?? triage.fitScore,
      matchType: deep?.matchType ?? triage.matchType,
      reason: triage.reason,
      enrichmentLevel: deep ? 'deep' : 'triage',
      redFlags: deep?.redFlags ?? candidate.predicted.redFlags,
      greenFlags: candidate.predicted.greenFlags,
      hiddenMatch: deep?.hiddenMatch ?? null,
      whyMatch: deep?.whyMatch,
      outreach: deep?.outreach,
    },
    notes: deep?.whyMatch ?? triage.reason,
    scoredAt: new Date().toISOString(),
  }

  await saveCandidates(candidates)
  return { ok: true, candidate: candidates[index], suggestion: suggestedLabelFor(candidates[index]) }
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Jobs Agent Admin</title>
  <style>
    :root {
      --ink: #1d2521;
      --muted: #66756d;
      --paper: #fbf7ef;
      --panel: #fffdf8;
      --line: #dfd5c4;
      --good: #0f766e;
      --maybe: #9a6700;
      --bad: #b42318;
      --accent: #1f7a5a;
      --accent-2: #d97706;
      --shadow: 0 18px 50px rgba(68, 54, 36, 0.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(31, 122, 90, 0.18), transparent 34rem),
        radial-gradient(circle at 90% 20%, rgba(217, 119, 6, 0.15), transparent 30rem),
        linear-gradient(135deg, #fbf7ef 0%, #f4ead8 100%);
      min-height: 100vh;
    }
    header {
      padding: 42px clamp(20px, 4vw, 56px) 22px;
      display: grid;
      gap: 18px;
    }
    h1 {
      margin: 0;
      max-width: 900px;
      font-size: clamp(42px, 8vw, 86px);
      line-height: 0.92;
      letter-spacing: -0.06em;
    }
    .subtitle {
      max-width: 720px;
      color: var(--muted);
      font: 17px/1.55 ui-sans-serif, system-ui, sans-serif;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      padding: 0 clamp(20px, 4vw, 56px) 24px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(255, 253, 248, 0.78);
      box-shadow: var(--shadow);
      padding: 14px 16px;
    }
    .stat strong {
      display: block;
      font-size: 28px;
      letter-spacing: -0.04em;
    }
    .stat span {
      color: var(--muted);
      font: 12px/1.3 ui-sans-serif, system-ui, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    main {
      padding: 0 clamp(20px, 4vw, 56px) 56px;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .insights {
      display: grid;
      gap: 16px;
      margin-bottom: 20px;
    }
    .insights-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
      gap: 14px;
    }
    .insight-panel {
      border: 1px solid var(--line);
      border-radius: 24px;
      background: rgba(255, 253, 248, 0.84);
      box-shadow: var(--shadow);
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    .insight-panel h3 {
      margin: 0;
      font-size: 24px;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .insight-list {
      display: grid;
      gap: 8px;
    }
    .insight-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(223, 213, 196, 0.6);
      font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
    }
    .insight-item:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .spotlight-card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255, 250, 240, 0.92);
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .toolbar-group {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255, 253, 248, 0.68);
    }
    .toolbar-label {
      color: var(--muted);
      font: 12px/1.2 ui-sans-serif, system-ui, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    button, select, input, textarea {
      font: 14px/1.3 ui-sans-serif, system-ui, sans-serif;
    }
    button, .chip {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.warn {
      background: var(--accent-2);
      border-color: var(--accent-2);
      color: white;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 430px), 1fr));
      gap: 16px;
      align-items: start;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 24px;
      background: rgba(255, 253, 248, 0.88);
      box-shadow: var(--shadow);
      padding: 18px;
      display: grid;
      gap: 12px;
    }
    .meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      color: var(--muted);
      font: 12px/1.2 ui-sans-serif, system-ui, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .score {
      color: white;
      background: var(--accent);
      border-radius: 999px;
      padding: 5px 9px;
    }
    .score.low { background: var(--bad); }
    .score.mid { background: var(--maybe); }
    .meta .chip {
      padding: 5px 9px;
    }
    .lane-chip {
      padding: 5px 9px;
      border-radius: 999px;
      font: 12px/1 ui-sans-serif, system-ui, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border: 1px solid var(--line);
      background: rgba(255, 250, 240, 0.9);
    }
    .lane-chip.traction { background: rgba(15, 118, 110, 0.14); color: var(--good); }
    .lane-chip.active { background: rgba(217, 119, 6, 0.14); color: var(--maybe); }
    .lane-chip.closed { background: rgba(180, 35, 24, 0.12); color: var(--bad); }
    .lane-chip.backlog { background: rgba(31, 122, 90, 0.1); color: var(--accent); }
    h2 {
      margin: 0;
      font-size: 24px;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    a { color: #0f5f46; }
    .muted {
      color: var(--muted);
      font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .details {
      color: #39443f;
      font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
      display: grid;
      gap: 7px;
    }
    .actions {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .run-panel {
      border: 1px solid var(--line);
      border-radius: 22px;
      background: rgba(255, 253, 248, 0.82);
      box-shadow: var(--shadow);
      padding: 14px;
      margin-bottom: 18px;
      display: grid;
      gap: 10px;
    }
    .run-panel pre {
      margin: 0;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      background: #1d2521;
      color: #fffdf8;
      border-radius: 14px;
      padding: 12px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .source-links {
      border: 1px solid var(--line);
      border-radius: 22px;
      background: rgba(255, 253, 248, 0.82);
      box-shadow: var(--shadow);
      padding: 16px;
      margin-bottom: 18px;
      display: grid;
      gap: 12px;
    }
    .source-links-header {
      display: grid;
      gap: 4px;
    }
    .source-links h3 {
      margin: 0;
      font-size: 22px;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .source-link-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
      gap: 12px;
    }
    .source-link-card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255, 250, 240, 0.88);
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .label-row {
      display: grid;
      grid-template-columns: 1fr 86px 1fr;
      gap: 8px;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #fffaf0;
      padding: 10px 11px;
      color: var(--ink);
    }
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: 420px;
      background: #1d2521;
      color: #fffdf8;
      padding: 13px 15px;
      border-radius: 16px;
      box-shadow: var(--shadow);
      font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
      transform: translateY(140%);
      transition: transform 180ms ease;
      z-index: 10;
    }
    .toast.show { transform: translateY(0); }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <h1>Jobs Agent Admin</h1>
    <div class="subtitle">Review discoveries, paste missing descriptions, and turn your judgement into eval gold. The agent proposes; you keep the taste.</div>
  </header>
  <section class="stats" id="stats"></section>
  <main>
    <section class="run-panel">
      <div class="toolbar" style="margin-bottom:0">
        <button class="primary" data-run-agent>Run agent</button>
        <button class="warn" data-run-agent-force>Run + Adzuna</button>
        <button data-refresh>Refresh</button>
      </div>
      <div class="muted" id="run-status">Agent idle.</div>
      <pre id="run-output" class="hidden"></pre>
    </section>
    <section class="insights" id="journey"></section>
    <section class="source-links hidden" id="source-links"></section>
    <div class="toolbar">
      <div class="toolbar-group">
        <span class="toolbar-label">Pipeline</span>
        <button class="primary" data-lane-filter="all">All lanes</button>
        <button data-lane-filter="traction">Momentum</button>
        <button data-lane-filter="active">Waiting</button>
        <button data-lane-filter="closed">Closed</button>
        <button data-lane-filter="backlog">Backlog</button>
      </div>
      <div class="toolbar-group">
        <span class="toolbar-label">Candidates</span>
        <button class="primary" data-filter="all">All</button>
        <button data-filter="ready">Ready to label</button>
        <button data-filter="needs">Needs description</button>
        <button data-filter="unlabeled">Unlabeled</button>
        <button data-filter="golden">In golden</button>
      </div>
      <div class="toolbar-group">
        <span class="toolbar-label">Dates</span>
        <button class="primary" data-date-filter="all">All dates</button>
        <button data-date-filter="today">Today</button>
        <button data-date-filter="7d">Last 7 days</button>
        <button data-date-filter="30d">Last 30 days</button>
      </div>
      <div class="toolbar-group">
        <span class="toolbar-label">Progress</span>
        <button class="primary" data-progress-filter="all">All progress</button>
        <button data-progress-filter="applied">Applied</button>
        <button data-progress-filter="interviewing">Interviewed</button>
      </div>
    </div>
    <section class="grid" id="cards"></section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    let state = {
      candidates: [],
      counts: {},
      filter: 'all',
      laneFilter: 'all',
      dateFilter: 'all',
      progressFilter: 'all',
      dashboard: { summary: {}, working: [], stalled: [], spotlight: [] },
      sourceHealth: { generatedAt: '', sources: [] },
    }

    const $ = (selector, root = document) => root.querySelector(selector)
    const escapeHtml = (value = '') => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')

    const toast = (message) => {
      const el = $('#toast')
      el.textContent = message
      el.classList.add('show')
      setTimeout(() => el.classList.remove('show'), 2600)
    }

    const api = async (url, options = {}) => {
      const res = await fetch(url, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Request failed')
      return data
    }

    const load = async () => {
      state = { ...state, ...(await api('/api/candidates')) }
      render()
    }

    const scoreClass = (score) => score >= 8 ? '' : score >= 6 ? 'mid' : 'low'
    const formatCapturedAt = (value) => {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return 'Unknown date'
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    }
    const laneLabel = (lane) => ({
      traction: 'Momentum',
      active: 'Waiting',
      closed: 'Closed',
      backlog: 'Backlog',
    }[lane] || 'Backlog')

    const isInDateRange = (candidate, filter, now = new Date()) => {
      if (filter === 'all') return true
      const capturedAt = new Date(candidate.capturedAt)
      if (Number.isNaN(capturedAt.getTime())) return false

      const startOfToday = new Date(now)
      startOfToday.setHours(0, 0, 0, 0)

      if (filter === 'today') return capturedAt >= startOfToday && capturedAt <= now

      const start = new Date(startOfToday)
      start.setDate(start.getDate() - (filter === '7d' ? 6 : 29))
      return capturedAt >= start && capturedAt <= now
    }

    const matchesProgress = (candidate, filter) => {
      if (filter === 'all') return true
      return (candidate.outcome || '') === filter
    }

    const visibleCandidates = () => state.candidates.filter((candidate) => {
      const matchesCandidateFilter =
        state.filter === 'ready'
          ? Boolean(candidate.description?.trim())
          : state.filter === 'needs'
            ? candidate.status === 'needs_description'
            : state.filter === 'unlabeled'
              ? Boolean(candidate.description?.trim()) && !candidate.label
              : state.filter === 'golden'
                ? candidate.inGolden
                : true

      return (
        matchesCandidateFilter &&
        (state.laneFilter === 'all' || candidate.journeyLane === state.laneFilter) &&
        isInDateRange(candidate, state.dateFilter) &&
        matchesProgress(candidate, state.progressFilter)
      )
    })

    const renderStats = () => {
      $('#stats').innerHTML = [
        ['Total', state.counts.total],
        ['Ready', state.counts.ready],
        ['Needs desc', state.counts.needsDescription],
        ['Labeled', state.counts.labeled],
        ['Golden', state.counts.golden],
      ].map(([label, value]) => \`
        <div class="stat"><strong>\${value ?? 0}</strong><span>\${label}</span></div>
      \`).join('')
    }

    const renderCard = (candidate) => {
      const suggestion = candidate.suggestion
      const label = candidate.label ?? suggestion?.label ?? 'maybe'
      const score = candidate.expectedScore ?? suggestion?.score ?? candidate.predicted.fitScore
      const matchType = candidate.expectedMatchType ?? suggestion?.matchType ?? candidate.predicted.matchType
      const reason = candidate.notes || suggestion?.reason || candidate.predicted.reason
      const needsDescription = candidate.status === 'needs_description'
      const outcome = candidate.outcome || ''
      const outcomeNotes = candidate.outcomeNotes || ''
      const capturedAt = formatCapturedAt(candidate.capturedAt)
      const lane = candidate.journeyLane || 'backlog'

      return \`
        <article class="card" data-id="\${escapeHtml(candidate.id)}">
          <div class="meta">
            <span class="score \${scoreClass(candidate.predicted.fitScore)}">\${candidate.predicted.fitScore}/10</span>
            <span>\${escapeHtml(candidate.predicted.matchType)}</span>
            <span>\${escapeHtml(candidate.source)}</span>
            <span class="lane-chip \${escapeHtml(lane)}">\${escapeHtml(laneLabel(lane))}</span>
            <span>\${escapeHtml(capturedAt)}</span>
            \${outcome ? \`<span class="chip">\${escapeHtml(outcome)}</span>\` : ''}
            \${candidate.inGolden ? '<span class="chip">golden</span>' : ''}
            \${candidate.label ? '<span class="chip">labeled</span>' : ''}
          </div>
          <h2>\${escapeHtml(candidate.company)} · \${escapeHtml(candidate.title)}</h2>
          <div class="muted">\${escapeHtml(candidate.location || 'Unknown location')}</div>
          \${candidate.url ? \`<a href="\${escapeHtml(candidate.url)}" target="_blank" rel="noreferrer">Open job</a>\` : ''}
          <div class="details">
            \${candidate.predicted.whyMatch ? \`<div><strong>Why:</strong> \${escapeHtml(candidate.predicted.whyMatch)}</div>\` : ''}
            \${candidate.predicted.hiddenMatch ? \`<div><strong>Hidden:</strong> \${escapeHtml(candidate.predicted.hiddenMatch)}</div>\` : ''}
            <div><strong>Green:</strong> \${escapeHtml((candidate.predicted.greenFlags ?? []).join(', ') || '-')}</div>
            <div><strong>Red:</strong> \${escapeHtml((candidate.predicted.redFlags ?? []).join(', ') || '-')}</div>
            \${suggestion ? \`<div><strong>Suggestion:</strong> \${suggestion.label} \${suggestion.score}/\${suggestion.matchType} · \${escapeHtml(suggestion.reason)}</div>\` : ''}
          </div>
          <div class="actions">
            \${needsDescription ? \`
              <textarea data-description placeholder="Paste LinkedIn description here"></textarea>
              <button class="warn" data-score>Score with GPT</button>
            \` : \`
              <div class="label-row">
                <select data-label>
                  \${['yes', 'maybe', 'no'].map(v => \`<option value="\${v}" \${v === label ? 'selected' : ''}>\${v}</option>\`).join('')}
                </select>
                <input data-expected-score type="number" min="1" max="10" value="\${score}" />
                <select data-match-type>
                  \${['direct', 'stretch', 'reach', 'skip'].map(v => \`<option value="\${v}" \${v === matchType ? 'selected' : ''}>\${v}</option>\`).join('')}
                </select>
              </div>
              <input data-reason value="\${escapeHtml(reason)}" />
              <select data-outcome>
                \${['', 'interested', 'applied', 'interviewing', 'rejected', 'ghosted', 'not_interested'].map(v => \`<option value="\${v}" \${v === outcome ? 'selected' : ''}>\${v || 'outcome...'}</option>\`).join('')}
              </select>
              <input data-outcome-notes value="\${escapeHtml(outcomeNotes)}" placeholder="What happened? e.g. applied, recruiter replied, rejected..." />
              <button class="primary" data-label-save>Save to golden</button>
            \`}
            <div class="\${needsDescription ? '' : 'hidden'}">
              <select data-outcome>
                \${['', 'interested', 'applied', 'interviewing', 'rejected', 'ghosted', 'not_interested'].map(v => \`<option value="\${v}" \${v === outcome ? 'selected' : ''}>\${v || 'outcome...'}</option>\`).join('')}
              </select>
              <input data-outcome-notes value="\${escapeHtml(outcomeNotes)}" placeholder="What happened?" />
              <button data-outcome-save>Save outcome</button>
            </div>
          </div>
        </article>
      \`
    }

    const renderSourceLinks = () => {
      const section = $('#source-links')
      const failures = (state.sourceHealth?.sources ?? []).filter((source) =>
        source.status === 'error' && /404/.test(source.error || '')
      )

      if (failures.length === 0) {
        section.innerHTML = ''
        section.classList.add('hidden')
        return
      }

      section.innerHTML = \`
        <div class="source-links-header">
          <h3>Application links</h3>
          <div class="muted">Helpful exits for ATS sources returning 404. Saved from the last agent run.</div>
        </div>
        <div class="source-link-list">
          \${failures.map((source) => \`
            <article class="source-link-card">
              <div class="meta">
                <span class="chip">404</span>
                <span>\${escapeHtml(source.ats)}</span>
              </div>
              <div><strong>\${escapeHtml(source.company)}</strong></div>
              <div class="muted">\${escapeHtml(source.error || 'Source error')}</div>
              <a href="\${escapeHtml(source.applicationLink.url)}" target="_blank" rel="noreferrer">
                \${source.applicationLink.kind === 'careers' ? 'Open careers page' : 'Find application page'}
              </a>
            </article>
          \`).join('')}
        </div>
      \`
      section.classList.remove('hidden')
    }

    const renderJourney = () => {
      const dashboard = state.dashboard || { summary: {}, working: [], stalled: [], spotlight: [] }
      $('#journey').innerHTML = \`
        <div class="insights-grid">
          <section class="insight-panel">
            <h3>Search reality</h3>
            <div class="details">
              <div><strong>\${dashboard.summary.tracked ?? 0}</strong> tracked opportunities with a real learning signal.</div>
              <div><strong>\${dashboard.summary.traction ?? 0}</strong> generated momentum.</div>
              <div><strong>\${dashboard.summary.active ?? 0}</strong> are still waiting on response.</div>
              <div><strong>\${dashboard.summary.backlog ?? 0}</strong> need a decision or next action.</div>
            </div>
          </section>
          <section class="insight-panel">
            <h3>What worked</h3>
            <div class="insight-list">
              \${(dashboard.working?.length ? dashboard.working : [{ label: 'Still collecting signal', count: 0 }]).map((item) => \`
                <div class="insight-item"><span>\${escapeHtml(item.label)}</span><strong>\${item.count}</strong></div>
              \`).join('')}
            </div>
          </section>
          <section class="insight-panel">
            <h3>What stalled</h3>
            <div class="insight-list">
              \${(dashboard.stalled?.length ? dashboard.stalled : [{ label: 'No repeated blocker yet', count: 0 }]).map((item) => \`
                <div class="insight-item"><span>\${escapeHtml(item.label)}</span><strong>\${item.count}</strong></div>
              \`).join('')}
            </div>
          </section>
        </div>
        <div class="insights-grid">
          \${(dashboard.spotlight ?? []).map((item) => \`
            <article class="spotlight-card">
              <div class="meta">
                <span class="lane-chip \${escapeHtml(item.lane)}">\${escapeHtml(laneLabel(item.lane))}</span>
                <span>\${escapeHtml(item.outcome)}</span>
              </div>
              <div><strong>\${escapeHtml(item.company)}</strong> · \${escapeHtml(item.title)}</div>
              <div class="muted">\${escapeHtml(item.reason || 'No note yet')}</div>
            </article>
          \`).join('')}
        </div>
      \`
    }

    const render = () => {
      renderStats()
      renderJourney()
      renderSourceLinks()
      $('#cards').innerHTML = visibleCandidates().map(renderCard).join('')
    }

    document.addEventListener('click', async (event) => {
      const laneFilter = event.target.closest('[data-lane-filter]')?.dataset.laneFilter
      if (laneFilter) {
        state.laneFilter = laneFilter
        document.querySelectorAll('[data-lane-filter]').forEach((button) => {
          button.classList.toggle('primary', button.dataset.laneFilter === laneFilter)
        })
        render()
        return
      }

      const filter = event.target.closest('[data-filter]')?.dataset.filter
      if (filter) {
        state.filter = filter
        document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('primary', button.dataset.filter === filter))
        render()
        return
      }

      const dateFilter = event.target.closest('[data-date-filter]')?.dataset.dateFilter
      if (dateFilter) {
        state.dateFilter = dateFilter
        document.querySelectorAll('[data-date-filter]').forEach((button) => {
          button.classList.toggle('primary', button.dataset.dateFilter === dateFilter)
        })
        render()
        return
      }

      const progressFilter = event.target.closest('[data-progress-filter]')?.dataset.progressFilter
      if (progressFilter) {
        state.progressFilter = progressFilter
        document.querySelectorAll('[data-progress-filter]').forEach((button) => {
          button.classList.toggle('primary', button.dataset.progressFilter === progressFilter)
        })
        render()
        return
      }

      const refreshButton = event.target.closest('[data-refresh]')
      if (refreshButton) {
        await load()
        toast('Refreshed')
        return
      }

      const runButton = event.target.closest('[data-run-agent], [data-run-agent-force]')
      if (runButton) {
        runButton.disabled = true
        try {
          const forceAdzuna = Boolean(event.target.closest('[data-run-agent-force]'))
          await api('/api/run-agent', {
            method: 'POST',
            body: JSON.stringify({ forceAdzuna }),
          })
          toast(forceAdzuna ? 'Agent started with Adzuna' : 'Agent started')
          pollRunStatus()
        } catch (error) {
          toast(error.message)
        } finally {
          runButton.disabled = false
        }
        return
      }

      const scoreButton = event.target.closest('[data-score]')
      if (scoreButton) {
        const card = event.target.closest('.card')
        scoreButton.disabled = true
        scoreButton.textContent = 'Scoring...'
        try {
          await api('/api/score', {
            method: 'POST',
            body: JSON.stringify({
              id: card.dataset.id,
              description: $('[data-description]', card).value,
            }),
          })
          toast('Scored candidate')
          await load()
        } catch (error) {
          toast(error.message)
          scoreButton.disabled = false
          scoreButton.textContent = 'Score with GPT'
        }
        return
      }

      const labelButton = event.target.closest('[data-label-save]')
      if (labelButton) {
        const card = event.target.closest('.card')
        labelButton.disabled = true
        labelButton.textContent = 'Saving...'
        try {
          await api('/api/label', {
            method: 'POST',
            body: JSON.stringify({
              id: card.dataset.id,
              label: $('[data-label]', card).value,
              score: $('[data-expected-score]', card).value,
              matchType: $('[data-match-type]', card).value,
              reason: $('[data-reason]', card).value,
              outcome: $('[data-outcome]', card)?.value,
              outcomeNotes: $('[data-outcome-notes]', card)?.value,
            }),
          })
          toast('Saved to golden')
          await load()
        } catch (error) {
          toast(error.message)
          labelButton.disabled = false
          labelButton.textContent = 'Save to golden'
        }
        return
      }

      const outcomeButton = event.target.closest('[data-outcome-save]')
      if (outcomeButton) {
        const card = event.target.closest('.card')
        outcomeButton.disabled = true
        try {
          await api('/api/outcome', {
            method: 'POST',
            body: JSON.stringify({
              id: card.dataset.id,
              outcome: $('[data-outcome]', card)?.value,
              outcomeNotes: $('[data-outcome-notes]', card)?.value,
            }),
          })
          toast('Outcome saved')
          await load()
        } catch (error) {
          toast(error.message)
        } finally {
          outcomeButton.disabled = false
        }
      }
    })

    const pollRunStatus = async () => {
      try {
        const data = await api('/api/run-status')
        const run = data.run
        if (!run) {
          $('#run-status').textContent = 'Agent idle.'
          $('#run-output').classList.add('hidden')
          return
        }
        $('#run-status').textContent = run.running
          ? \`Running since \${run.startedAt}\${run.forceAdzuna ? ' · Adzuna forced' : ''}\`
          : \`Last run finished \${run.finishedAt} · exit \${run.exitCode}\`
        $('#run-output').textContent = run.output || ''
        $('#run-output').classList.toggle('hidden', !run.output)
        if (run.running) {
          setTimeout(pollRunStatus, 2000)
        } else {
          await load()
        }
      } catch (error) {
        $('#run-status').textContent = error.message
      }
    }

    load().catch(error => toast(error.message))
    pollRunStatus()
  </script>
</body>
</html>`

const server = Bun.serve({
  port: Number(process.env.ADMIN_PORT ?? 8787),
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (request.method === 'GET' && url.pathname === '/api/candidates') {
        return json(await getCandidatesPayload())
      }
      if (request.method === 'GET' && url.pathname === '/api/run-status') {
        return json({ run: agentRun })
      }
      if (request.method === 'POST' && url.pathname === '/api/run-agent') {
        return json(runAgent(await readJsonBody(request)))
      }
      if (request.method === 'POST' && url.pathname === '/api/score') {
        return json(await scoreCandidate(await readJsonBody(request)))
      }
      if (request.method === 'POST' && url.pathname === '/api/label') {
        return json(await labelCandidate(await readJsonBody(request)))
      }
      if (request.method === 'POST' && url.pathname === '/api/outcome') {
        return json(await saveOutcome(await readJsonBody(request)))
      }
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  },
})

console.log(`Jobs Agent Admin running at http://localhost:${server.port}`)
