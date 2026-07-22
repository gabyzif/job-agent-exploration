import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { sendJobsDigest } from './notifications/email-digest.ts'

const CANDIDATES_PATH = path.join(import.meta.dirname, '../eval/candidates.json')

const candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, 'utf-8'))

const topMatches = candidates
  .filter((candidate: any) => candidate.status !== 'needs_description')
  .filter((candidate: any) => candidate.predicted?.fitScore >= 7)
  .sort((a: any, b: any) => b.predicted.fitScore - a.predicted.fitScore)
  .slice(0, 15)
  .map((candidate: any) => ({
    company: candidate.company,
    title: candidate.title,
    location: candidate.location,
    url: candidate.url,
    source: candidate.source,
    fitScore: candidate.predicted.fitScore,
    matchType: candidate.predicted.matchType,
    whyMatch: candidate.predicted.whyMatch ?? candidate.notes ?? candidate.predicted.reason,
    hiddenMatch: candidate.predicted.hiddenMatch,
    redFlags: candidate.predicted.redFlags ?? [],
  }))

const needsDescription = candidates
  .filter((candidate: any) => candidate.status === 'needs_description')
  .sort((a: any, b: any) => b.predicted.fitScore - a.predicted.fitScore)
  .slice(0, 15)

const result = await sendJobsDigest({
  topMatches,
  needsDescription,
  gmailUser: process.env.GMAIL_USER ?? '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD ?? '',
  to: process.env.JOBS_DIGEST_EMAIL_TO ?? process.env.GMAIL_USER,
})

console.log(JSON.stringify(result))
