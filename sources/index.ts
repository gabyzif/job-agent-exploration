import { fetchGreenhouse } from './ats-greenhouse.ts'
import { fetchLever } from './ats-lever.ts'
import { fetchAshby } from './ats-ashby.ts'
import { fetchSmartRecruiters } from './ats-smartrecruiters.ts'
import { fetchWorkable } from './ats-workable.ts'
import { fetchPersonio } from './ats-personio.ts'
import { fetchTeamTailor } from './ats-teamtailor.ts'
import type { ATS, ATSAdapter } from './types.ts'

export const atsAdapters: Record<ATS, ATSAdapter> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  personio: fetchPersonio,
  teamtailor: fetchTeamTailor,
}

export type { ATS, RawJob, Job, Company, ATSAdapter } from './types.ts'
