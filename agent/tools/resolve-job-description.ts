import { fetchAshby } from '../../sources/ats-ashby.ts'
import { fetchGreenhouse } from '../../sources/ats-greenhouse.ts'
import { fetchLever } from '../../sources/ats-lever.ts'
import { fetchPersonio } from '../../sources/ats-personio.ts'
import { fetchSmartRecruiters } from '../../sources/ats-smartrecruiters.ts'
import { fetchTeamTailor } from '../../sources/ats-teamtailor.ts'
import { fetchWorkable } from '../../sources/ats-workable.ts'
import type { RawJob } from '../../types.ts'

type ResolveStatus = 'resolved' | 'needs_manual_description' | 'unsupported' | 'not_found' | 'error'

export type ResolveJobDescriptionResult = {
  status: ResolveStatus
  provider: string
  reason?: string
  job?: RawJob
}

type ProviderResolver = (url: URL) => Promise<ResolveJobDescriptionResult | null>

const cleanLinkedInUrl = (url: URL) => {
  const match = url.pathname.match(/\/jobs\/view\/(\d+)/)
  return match ? `https://www.linkedin.com/comm/jobs/view/${match[1]}` : url.toString()
}

const findByUrlOrId = (jobs: RawJob[], url: URL, id?: string) =>
  jobs.find((job) => {
    if (id && job.id.endsWith(`-${id}`)) return true
    return job.url === url.toString() || job.url.split('?')[0] === url.toString().split('?')[0]
  })

const greenhouseResolver: ProviderResolver = async (url) => {
  const match = url.hostname.match(/(?:boards|job-boards)\.greenhouse\.io$/)
  if (!match) return null

  const [, slug, id] = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/) ?? []
  if (!slug) {
    return {
      status: 'unsupported',
      provider: 'greenhouse',
      reason: 'Greenhouse URL did not include a board slug.',
    }
  }

  const jobs = await fetchGreenhouse(slug)
  const job = findByUrlOrId(jobs, url, id)
  return job
    ? { status: 'resolved', provider: 'greenhouse', job }
    : { status: 'not_found', provider: 'greenhouse', reason: 'Job was not found on the public board API.' }
}

const leverResolver: ProviderResolver = async (url) => {
  if (url.hostname !== 'jobs.lever.co') return null

  const [, slug, id] = url.pathname.match(/^\/([^/]+)\/([^/?#]+)/) ?? []
  if (!slug) {
    return { status: 'unsupported', provider: 'lever', reason: 'Lever URL did not include a company slug.' }
  }

  const jobs = await fetchLever(slug)
  const job = findByUrlOrId(jobs, url, id)
  return job
    ? { status: 'resolved', provider: 'lever', job }
    : { status: 'not_found', provider: 'lever', reason: 'Job was not found on the public postings API.' }
}

const ashbyResolver: ProviderResolver = async (url) => {
  if (url.hostname !== 'jobs.ashbyhq.com') return null

  const [, slug] = url.pathname.match(/^\/([^/]+)/) ?? []
  if (!slug) {
    return { status: 'unsupported', provider: 'ashby', reason: 'Ashby URL did not include a board slug.' }
  }

  const jobs = await fetchAshby(slug)
  const job = findByUrlOrId(jobs, url)
  return job
    ? { status: 'resolved', provider: 'ashby', job }
    : { status: 'not_found', provider: 'ashby', reason: 'Job was not found on the public job board API.' }
}

const workableResolver: ProviderResolver = async (url) => {
  if (url.hostname !== 'apply.workable.com') return null

  const [, slug] = url.pathname.match(/^\/([^/]+)/) ?? []
  if (!slug) {
    return {
      status: 'unsupported',
      provider: 'workable',
      reason: 'Workable URL did not include an account slug.',
    }
  }

  const jobs = await fetchWorkable(slug)
  const job = findByUrlOrId(jobs, url)
  return job
    ? { status: 'resolved', provider: 'workable', job }
    : { status: 'not_found', provider: 'workable', reason: 'Job was not found on the public widget API.' }
}

const smartRecruitersResolver: ProviderResolver = async (url) => {
  if (url.hostname !== 'jobs.smartrecruiters.com') return null

  const [, slug, id] = url.pathname.match(/^\/([^/]+)\/([^/?#]+)/) ?? []
  if (!slug || !id) {
    return {
      status: 'unsupported',
      provider: 'smartrecruiters',
      reason: 'SmartRecruiters URL did not include company slug and posting id.',
    }
  }

  const jobs = await fetchSmartRecruiters(slug)
  const job = findByUrlOrId(jobs, url, id)
  return job
    ? { status: 'resolved', provider: 'smartrecruiters', job }
    : {
        status: 'not_found',
        provider: 'smartrecruiters',
        reason: 'Job was not found on the public posting API.',
      }
}

const personioResolver: ProviderResolver = async (url) => {
  const hostMatch = url.hostname.match(/^(.+)\.jobs\.personio\.de$/)
  if (!hostMatch) return null

  const slug = hostMatch[1]
  const [, id] = url.pathname.match(/^\/job\/(\d+)/) ?? []
  const jobs = await fetchPersonio(slug)
  const job = findByUrlOrId(jobs, url, id)
  return job
    ? { status: 'resolved', provider: 'personio', job }
    : { status: 'not_found', provider: 'personio', reason: 'Job was not found in the public XML feed.' }
}

const teamTailorResolver: ProviderResolver = async (url) => {
  const hostMatch = url.hostname.match(/^(.+)\.teamtailor\.com$/)
  if (!hostMatch) return null

  const slug = hostMatch[1]
  const [, id] = url.pathname.match(/^\/jobs\/([^/?#]+)/) ?? []
  const jobs = await fetchTeamTailor(slug)
  const job = findByUrlOrId(jobs, url, id)
  return job
    ? { status: 'resolved', provider: 'teamtailor', job }
    : { status: 'not_found', provider: 'teamtailor', reason: 'Job was not found on the public jobs feed.' }
}

const resolvers: ProviderResolver[] = [
  greenhouseResolver,
  leverResolver,
  ashbyResolver,
  workableResolver,
  smartRecruitersResolver,
  personioResolver,
  teamTailorResolver,
]

export const resolveJobDescription = async (jobUrl: string): Promise<ResolveJobDescriptionResult> => {
  let url: URL
  try {
    url = new URL(jobUrl)
  } catch {
    return { status: 'error', provider: 'unknown', reason: 'Invalid URL.' }
  }

  if (url.hostname.includes('linkedin.com')) {
    return {
      status: 'needs_manual_description',
      provider: 'linkedin',
      reason: `LinkedIn pages are not fetched automatically. Open ${cleanLinkedInUrl(url)} and paste the description if it looks promising.`,
    }
  }

  for (const resolver of resolvers) {
    try {
      const result = await resolver(url)
      if (result) return result
    } catch (error) {
      return {
        status: 'error',
        provider: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    status: 'unsupported',
    provider: 'unknown',
    reason: 'This URL is not from a supported public ATS provider yet.',
  }
}

export const resolveJobDescriptionTool = {
  description:
    'Resolve a job description from a safe public ATS URL. Does not scrape LinkedIn; LinkedIn returns needs_manual_description.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Job posting URL from LinkedIn or a supported ATS provider.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  execute: async ({ url }: { url: string }) => resolveJobDescription(url),
}
