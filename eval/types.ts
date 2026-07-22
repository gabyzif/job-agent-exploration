export type Label = 'yes' | 'no' | 'maybe'
export type MatchType = 'direct' | 'stretch' | 'reach' | 'skip'

export type GoldenCase = {
  id: string
  company: string
  title: string
  location: string
  url?: string
  description?: string
  label: Label
  expectedScore: number
  expectedMatchType: MatchType
  reason: string
  redFlags: string[]
  greenFlags: string[]
  outcome?: string
  notes?: string
}

export type GoldenSet = {
  _meta: {
    version: string
    labeler: string
    createdAt: string
    labelingRules: {
      label: string
      expectedScore: string
      expectedMatchType: string
      evalCounting: string
    }
  }
  cases: GoldenCase[]
}

export type DetectedSignals = {
  hardReject: boolean
  rejectReasons: string[]
  redFlags: string[]
  greenFlags: string[]
}

export type EvalResult = {
  id: string
  company: string
  title: string
  expected: {
    label: Label
    score: number
    matchType: MatchType
    redFlags: string[]
    greenFlags: string[]
  }
  detectedSignals: DetectedSignals
  triage: {
    fitScore: number
    matchType: MatchType
    reason: string
  }
  deep: {
    fitScore: number
    matchType: 'direct' | 'stretch' | 'reach'
    redFlags: string[]
    whyMatch: string
    hiddenMatch: string | null
    outreach: string | null
  } | null
  triageCorrect: boolean
  deepCorrect: boolean | null
  scoreDiff: number
}
