import type { RawJob } from '../types.ts'

type EvalJob = RawJob & { company: string }

type SignalContext = {
  knownGoodCompanies: string[]
  salaryFloor: number
}

type Rule = {
  kind: 'hardReject' | 'redFlag' | 'greenFlag'
  match: (job: EvalJob, context: SignalContext) => boolean
}

const KNOWN_CONSULTANCIES = [
  'capgemini',
  'accenture',
  'accenture song',
  'capitole',
  'agap2',
  'randstad',
  'randstad digital',
  'ntt data',
  'globant',
  'thoughtworks',
  'deloitte',
]

const TIER1_COMPANIES = [
  'google',
  'meta',
  'stripe',
  'anthropic',
  'datadog',
  'figma',
  'miro',
  'wise',
  'n26',
  'pleo',
  'contentful',
  'hugging face',
  'huggingface',
  'openai',
  'github',
]

const normalize = (value: string) => value.toLowerCase()

const hasKnownCompany = (company: string, list: string[]) => {
  const normalized = normalize(company)
  return list.some((entry) => normalized.includes(entry))
}

const parseSalaryMax = (description: string): number | null => {
  const matches = [...description.matchAll(/(\d{2,3})\s*k/gi)]
  if (matches.length === 0) return null
  return Math.max(...matches.map((match) => Number(match[1])))
}

const RULES: Record<string, Rule> = {
  anonymousSpanishStaffing: {
    kind: 'hardReject',
    match: (job) => {
      const desc = normalize(job.description)
      const signals = [
        /analista programador/i,
        /^buscamos un\/a/im,
        /nuestros laboratorios tecnol[oó]gicos/i,
        /una aplicaci[oó]n empresarial/i,
        /cliente final/i,
        /retribuci[oó]n flexible.*ticket restaurante/i,
      ]
      return signals.filter((rx) => rx.test(desc)).length >= 2
    },
  },
  contractorPool: {
    kind: 'hardReject',
    match: (job) => /pool of contractors|contractor network|freelance pool/i.test(job.title),
  },
  startupSmall: {
    kind: 'redFlag',
    match: (job, context) => {
      if (context.knownGoodCompanies.includes(job.company)) return false
      return /small.{0,6}(team|company)|small startup|early.stage|early stage|under 50 employees|< ?50 employees/i.test(
        job.description,
      )
    },
  },
  startupFragileRisk: {
    kind: 'redFlag',
    match: (job, context) => {
      if (context.knownGoodCompanies.includes(job.company)) return false
      return /wear many hats|scrappy|move fast and break things|build from scratch|0 to 1|founding/i.test(
        normalize(`${job.title} ${job.description}`),
      )
    },
  },
  startupSolidSignals: {
    kind: 'greenFlag',
    match: (job) =>
      /series [abc]\b|well-funded|backed by|backers|venture-backed|scale-up|growth stage/i.test(
        job.description,
      ),
  },
  cryptoHypeRisk: {
    kind: 'redFlag',
    match: (job) =>
      /\bcrypto(?:currenc(?:y|ies)| indices?)?\b|\bdigital assets?\b|\bweb3\b|\bblockchain\b|\btoken(?:s|ization)?\b|\bdefi\b|\bnfts?\b/i.test(
        normalize(`${job.company} ${job.description}`),
      ),
  },
  aiHypeRisk: {
    kind: 'redFlag',
    match: (job) => {
      const desc = normalize(job.description)
      const hasAIMention = /\b(ai|llm|genai|agentic|copilot)\b/i.test(desc)
      const hasHype = /revolutionary|disruptive|bleeding edge|10x|world-class|superstar/i.test(desc)
      const lacksConcreteStack = !/\breact\b|\btypescript\b|\bnode\b|next\.?js|python|java|spring|go\b/i.test(
        desc,
      )
      return hasAIMention && hasHype && lacksConcreteStack
    },
  },
  elitistCulture: {
    kind: 'redFlag',
    match: (job) => {
      const desc = normalize(job.description)
      const signals = [
        /less than \d+%.{0,40}(hired|candidates)/i,
        /top \d+%/i,
        /world.?class.{0,30}(individual|contributor|engineer)/i,
        /olympiad|chess champion|math olymp/i,
        /exceptional talent/i,
        /rockstar|10x (dev|engineer)/i,
      ]
      return signals.some((rx) => rx.test(desc))
    },
  },
  rubyCore: {
    kind: 'redFlag',
    match: (job) => {
      const desc = normalize(job.description)
      const idx = desc.search(/ruby on rails|\brails\b|\bruby\b/)
      if (idx === -1) return false
      const before = desc.slice(Math.max(0, idx - 300), idx)
      return !/nice to have|bonus|plus|valued|valorable|deseable/i.test(before)
    },
  },
  legacyStackCore: {
    kind: 'redFlag',
    match: (job) => /\b(angular|java|spring|hibernate|\.net|c#)\b/i.test(job.description),
  },
  officeHeavy: {
    kind: 'redFlag',
    match: (job) =>
      /70% office|80% office|office-first|4 days on.?site|5 days on.?site|20% remote/i.test(
        normalize(`${job.location} ${job.description}`),
      ),
  },
  salaryBelowFloor: {
    kind: 'redFlag',
    match: (job, context) => {
      const max = parseSalaryMax(job.description)
      return max !== null && max < context.salaryFloor
    },
  },
  locationMismatch: {
    kind: 'redFlag',
    match: (job) => {
      const loc = normalize(job.location)
      if (loc === '') return false
      const allowed = /barcelona|spain|españa|espana|europe|\beu\b|remote|hybrid|partially remote/i
      return !allowed.test(loc)
    },
  },
  languageMismatch: {
    kind: 'redFlag',
    match: (job) =>
      /france|french|fran[cç]ais|francia/i.test(`${job.location} ${job.description}`) &&
      !/english.?speaking|english is enough|english only|fluent in english/i.test(job.description),
  },
  knownConsultancy: {
    kind: 'greenFlag',
    match: (job) => hasKnownCompany(job.company, KNOWN_CONSULTANCIES),
  },
  aiFirstReal: {
    kind: 'greenFlag',
    match: (job) =>
      /claude code|cursor|mcp server|agentic ui|ai-assisted|ai enablement|genai/i.test(job.description),
  },
  stackMatchReactTSNode: {
    kind: 'greenFlag',
    match: (job) => {
      const desc = normalize(job.description)
      return /\breact\b/i.test(desc) && /\btypescript\b/i.test(desc) && /(\bnode\b|next\.?js)/i.test(desc)
    },
  },
  designSystems: {
    kind: 'greenFlag',
    match: (job) => /design system|component library|storybook|figma/i.test(job.description),
  },
  leadershipScope: {
    kind: 'greenFlag',
    match: (job) => /mentor|mentoring|leadership|tech lead|staff|architecture|cross-functional/i.test(
      normalize(`${job.title} ${job.description}`),
    ),
  },
  barcelonaHybrid: {
    kind: 'greenFlag',
    match: (job) => /barcelona/i.test(job.location) && /hybrid|remote|partially remote/i.test(job.location),
  },
  remoteEU: {
    kind: 'greenFlag',
    match: (job) => /remote/i.test(job.location) && /europe|\beu\b|spain|españa|espana/i.test(job.location),
  },
  tier1MidLevelTitle: {
    kind: 'greenFlag',
    match: (job) => {
      const isTier1 = hasKnownCompany(job.company, TIER1_COMPANIES)
      const isMidLevelTitle =
        /\b(engineer ii|software engineer|frontend engineer|full stack engineer|l4)\b/i.test(job.title) &&
        !/senior|staff|lead|principal/i.test(job.title)
      return isTier1 && isMidLevelTitle
    },
  },
}

export const detectJobSignals = (
  job: EvalJob,
  context: Partial<SignalContext> = {},
) => {
  const resolvedContext: SignalContext = {
    knownGoodCompanies: context.knownGoodCompanies ?? [],
    salaryFloor: context.salaryFloor ?? 50,
  }

  return Object.entries(RULES).reduce(
    (acc, [name, rule]) => {
      if (!rule.match(job, resolvedContext)) return acc
      if (rule.kind === 'hardReject') {
        acc.hardReject = true
        acc.rejectReasons.push(name)
      } else if (rule.kind === 'redFlag') {
        acc.redFlags.push(name)
      } else {
        acc.greenFlags.push(name)
      }
      return acc
    },
    {
      hardReject: false,
      rejectReasons: [] as string[],
      redFlags: [] as string[],
      greenFlags: [] as string[],
    },
  )
}
