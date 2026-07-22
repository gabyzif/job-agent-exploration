import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { deepEnrich, triageJob } from '../agent.ts'
import type { Job } from '../types.ts'
import type { GoldenCase, GoldenSet, Label, MatchType } from './types.ts'

type Candidate = {
  id: string
  company: string
  title: string
  location: string
  url: string
  description: string
  source: Job['source']
  status: 'ready_for_label' | 'needs_description' | 'scored'
  predicted: {
    fitScore: number
    matchType: 'direct' | 'stretch' | 'reach' | 'skip'
    reason: string
    enrichmentLevel: 'triage' | 'deep' | 'linkedin_pretriage'
    redFlags: string[]
    greenFlags?: string[]
    hiddenMatch: string | null
    whyMatch?: string
    outreach?: string | null
  }
  label: null | 'yes' | 'no' | 'maybe'
  expectedScore: null | number
  expectedMatchType: null | 'direct' | 'stretch' | 'reach' | 'skip'
  notes: string
  capturedAt: string
  scoredAt?: string
}

const CANDIDATES_PATH = path.join(import.meta.dirname, 'candidates.json')
const GOLDEN_PATH = path.join(import.meta.dirname, 'golden.json')
const DEEP_THRESHOLD = 7

const readStdin = async () => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}

const loadCandidates = async (): Promise<Candidate[]> =>
  JSON.parse(await fs.readFile(CANDIDATES_PATH, 'utf-8')) as Candidate[]

const saveCandidates = async (candidates: Candidate[]) =>
  fs.writeFile(CANDIDATES_PATH, JSON.stringify(candidates, null, 2))

const loadGolden = async (): Promise<GoldenSet> =>
  JSON.parse(await fs.readFile(GOLDEN_PATH, 'utf-8')) as GoldenSet

const saveGolden = async (golden: GoldenSet) =>
  fs.writeFile(GOLDEN_PATH, JSON.stringify(golden, null, 2))

const printCandidate = (candidate: Candidate, index?: number) => {
  const prefix = index === undefined ? '-' : `${index + 1}.`
  console.log(
    `${prefix} ${candidate.predicted.fitScore}/10 ${candidate.id} | ${candidate.company} | ${candidate.title}`,
  )
  console.log(`   ${candidate.location}`)
  console.log(`   ${candidate.url}`)
  console.log(`   green: ${(candidate.predicted.greenFlags ?? []).join(', ') || '-'}`)
  console.log(`   red: ${candidate.predicted.redFlags.join(', ') || '-'}`)
  console.log('')
}

const listCandidates = async () => {
  const candidates = await loadCandidates()
  const pending = candidates
    .filter((candidate) => candidate.status === 'needs_description')
    .sort((a, b) => b.predicted.fitScore - a.predicted.fitScore)

  if (pending.length === 0) {
    console.log('No candidates need description right now.')
    return
  }

  pending.forEach(printCandidate)
}

const showCandidates = async () => {
  const candidates = await loadCandidates()
  const scored = candidates
    .filter((candidate) => candidate.description.trim())
    .sort((a, b) => b.predicted.fitScore - a.predicted.fitScore)

  if (scored.length === 0) {
    console.log('No scored/description candidates yet.')
    return
  }

  scored.forEach((candidate, index) => {
    printCandidate(candidate, index)
    if (candidate.predicted.whyMatch) console.log(`   why: ${candidate.predicted.whyMatch}`)
    if (candidate.predicted.hiddenMatch) console.log(`   hidden: ${candidate.predicted.hiddenMatch}`)
    if (candidate.label) {
      console.log(`   label: ${candidate.label} ${candidate.expectedScore}/${candidate.expectedMatchType}`)
    }
    console.log('')
  })
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
      label: 'no' as const,
      score: Math.min(score, 5),
      matchType: candidate.predicted.matchType,
      confidence: 'medium',
      reason: 'Hard friction/red flag despite some surface match.',
    }
  }

  if (/bairesdev|the white team|experience it|plexus|sopra|irium|gfi|cas training/.test(company)) {
    return {
      label: 'maybe' as const,
      score: Math.min(score, 6),
      matchType: candidate.predicted.matchType,
      confidence: 'low',
      reason: 'Consultancy/staffing-ish source; needs human preference check.',
    }
  }

  if (score >= 8) {
    return {
      label: 'yes' as const,
      score,
      matchType: candidate.predicted.matchType,
      confidence: 'medium',
      reason: 'High predicted score with strong fit signals.',
    }
  }

  if (score >= 6) {
    return {
      label: 'maybe' as const,
      score,
      matchType: candidate.predicted.matchType,
      confidence: 'medium',
      reason: 'Review-worthy but not obvious yes.',
    }
  }

  return {
    label: 'no' as const,
    score,
    matchType: candidate.predicted.matchType,
    confidence: 'medium',
    reason: 'Below review threshold.',
  }
}

const suggestLabels = async () => {
  const candidates = await loadCandidates()
  const labelable = candidates
    .filter((candidate) => candidate.description.trim())
    .filter((candidate) => !candidate.label)
    .sort((a, b) => b.predicted.fitScore - a.predicted.fitScore)

  if (labelable.length === 0) {
    console.log('No unlabeled candidates with description.')
    return
  }

  labelable.forEach((candidate, index) => {
    const suggestion = suggestedLabelFor(candidate)
    console.log(
      `${index + 1}. ${candidate.id} | ${candidate.company} | ${candidate.title}`,
    )
    console.log(
      `   predicted: ${candidate.predicted.fitScore}/${candidate.predicted.matchType}`,
    )
    console.log(
      `   suggested: ${suggestion.label} ${suggestion.score}/${suggestion.matchType} (${suggestion.confidence})`,
    )
    console.log(`   reason: ${suggestion.reason}`)
    console.log(
      `   command: bun eval/candidates.ts label ${candidate.id} ${suggestion.label} ${suggestion.score} ${suggestion.matchType} "${suggestion.reason}"`,
    )
    console.log('')
  })
}

const scoreCandidate = async (id: string) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY')

  const description = await readStdin()
  if (!description) {
    throw new Error('Pegá la descripción por stdin. Ej: pbpaste | bun eval/candidates.ts score <id>')
  }

  const candidates = await loadCandidates()
  const index = candidates.findIndex((candidate) => candidate.id === id)
  if (index === -1) throw new Error(`No existe candidate: ${id}`)

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

  const score = deep?.fitScore ?? triage.fitScore
  const matchType = deep?.matchType ?? triage.matchType

  candidates[index] = {
    ...candidate,
    description,
    status: 'scored',
    predicted: {
      fitScore: score,
      matchType,
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

  console.log(`${score}/10 ${matchType} | ${candidate.company} | ${candidate.title}`)
  console.log(triage.reason)
  if (deep?.whyMatch) console.log(`why: ${deep.whyMatch}`)
  if (deep?.hiddenMatch) console.log(`hidden: ${deep.hiddenMatch}`)
  if (deep?.redFlags.length) console.log(`red: ${deep.redFlags.join(', ')}`)
}

const parseLabel = (value: string): Label => {
  if (value === 'yes' || value === 'no' || value === 'maybe') return value
  throw new Error('label debe ser yes | no | maybe')
}

const parseMatchType = (value: string): MatchType => {
  if (value === 'direct' || value === 'stretch' || value === 'reach' || value === 'skip') return value
  throw new Error('matchType debe ser direct | stretch | reach | skip')
}

const parseScore = (value: string): number => {
  const score = Number(value)
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error('score debe ser un entero de 1 a 10')
  }
  return score
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
  outcome: 'promoted_from_candidate',
  notes: candidate.notes,
})

const labelCandidate = async (
  id: string,
  rawLabel: string,
  rawScore: string,
  rawMatchType: string,
  reasonParts: string[],
) => {
  const label = parseLabel(rawLabel)
  const expectedScore = parseScore(rawScore)
  const expectedMatchType = parseMatchType(rawMatchType)
  const reason = reasonParts.join(' ').trim()
  if (!reason) throw new Error('Agregá una razón. Ej: bun eval/candidates.ts label <id> yes 8 stretch \"why\"')

  const candidates = await loadCandidates()
  const index = candidates.findIndex((candidate) => candidate.id === id)
  if (index === -1) throw new Error(`No existe candidate: ${id}`)

  const candidate = candidates[index]
  if (!candidate.description.trim()) {
    throw new Error('Este candidate no tiene description. Primero: pbpaste | bun eval/candidates.ts score <id>')
  }

  candidates[index] = {
    ...candidate,
    label,
    expectedScore,
    expectedMatchType,
    notes: reason,
  }

  const golden = await loadGolden()
  const goldenCase = candidateToGoldenCase({
    candidate: candidates[index],
    label,
    expectedScore,
    expectedMatchType,
    reason,
  })
  const existingIndex = golden.cases.findIndex((entry) => entry.id === id)
  if (existingIndex === -1) {
    golden.cases.push(goldenCase)
  } else {
    golden.cases[existingIndex] = goldenCase
  }

  await saveCandidates(candidates)
  await saveGolden(golden)

  console.log(`✓ labeled ${id}: ${label} ${expectedScore}/${expectedMatchType}`)
  console.log(`✓ golden cases: ${golden.cases.length}`)
}

const usage = () => {
  console.log(`Usage:
  bun eval/candidates.ts list
  bun eval/candidates.ts show
  bun eval/candidates.ts suggest
  pbpaste | bun eval/candidates.ts score <candidate-id>
  bun eval/candidates.ts label <candidate-id> <yes|no|maybe> <1-10> <direct|stretch|reach|skip> "reason"`)
}

const [command, id, arg1, arg2, arg3, ...rest] = process.argv.slice(2)

try {
  if (command === 'list') {
    await listCandidates()
  } else if (command === 'show') {
    await showCandidates()
  } else if (command === 'suggest') {
    await suggestLabels()
  } else if (command === 'score' && id) {
    await scoreCandidate(id)
  } else if (command === 'label' && id && arg1 && arg2 && arg3) {
    await labelCandidate(id, arg1, arg2, arg3, rest)
  } else {
    usage()
    process.exitCode = 1
  }
} catch (error) {
  console.error(`FATAL: ${(error as Error).message}`)
  process.exit(1)
}
