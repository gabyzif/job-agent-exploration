# Jobs Agent - Context for Claude Code

## What this is
Personal job search agent for G (Senior Frontend Engineer, Barcelona). Runs 3x/day via cron, fetches jobs from ATS APIs (Greenhouse/Lever/Ashby), filters them, enriches via Claude Haiku, and notifies via WhatsApp when there are matches with fitScore >= 7.

## Goal
Find roles G WOULDN'T find herself by scanning titles. Surface stretch matches (fullstack, product eng, AI work) hidden behind generic titles like "Software Engineer". Her CV undersells her actual capabilities.

## Architecture
```
companies.ts → atsAdapters[ats](slug) → filters (title+description) → dedupe vs state.json
                                                                            ↓
                                                                  Claude Haiku enrichment
                                                                            ↓
                                                                  WhatsApp top matches (>=7)
                                                                            ↓
                                                                  Save state + runs/YYYY-MM-DD.json
```

## Files
- `agent.ts` - pipeline + adapters + filters + Claude enrichment + WhatsApp notify
- `companies.ts` - target company list (edit freely)
- `state.json` - seen job IDs (don't manually edit)
- `runs/*.json` - daily output for offline review
- `agent.log` - cron stdout/stderr

## Key design decisions
- **Description > title**: titles lie (esp. at big companies). Hard filter only rejects non-tech titles + explicit junior. Real scoring uses description.
- **Tier-aware seniority**: "Engineer II" at Google/Stripe pays better than "Senior" at a Spanish scale-up. Don't filter by senior keyword; let Claude weigh it with company tier.
- **Pre-screen by tech signals**: regex on description requires >=2 hits (React/TS/design system/Figma/etc.) before going to Claude. Cost optimization.
- **Three match types in output**: direct / stretch / reach. Stretch is the gold.
- **hiddenMatch field**: when role asks for something G does but doesn't lead with on CV (fullstack, AI, product eng, CMS, a11y, public speaking) - tells her exactly what to mention in application.
- **Maps over ifs**: G's preference. Filters, scorers, adapters all use Record<string, Fn> maps so adding new criteria = one entry.

## Running
```bash
# Set envs first
export ANTHROPIC_API_KEY=sk-ant-...
export WHATSAPP_PHONE=34XXXXXXXXX
export CALLMEBOT_KEY=...

# Manual run
bun agent.ts

# Output goes to stdout (matches), stderr (logs), runs/*.json (full enriched data)
```

## Cron schedule
11h / 16h / 20h CET, Monday-Friday only. Based on data showing Tuesday 11 AM is peak posting time for EU recruiters, second peak 4 PM.

## Common tasks
- **Broken slug**: log shows `✗ CompanyName: 404` → fix slug in companies.ts (check their careers page URL)
- **Add company**: one line in companies.ts (need: name, ats type, slug)
- **Add new ATS**: add entry to `atsAdapters` map in agent.ts. SmartRecruiters and Workday are common for consultancies.
- **Score calibration off**: review last runs/*.json, adjust PROFILE or rubric in `enrichJob` prompt
- **Costs too high**: increase MIN_SIGNALS, reduce slice(0, 30) cap in pipeline, or check if a company is returning huge numbers of irrelevant jobs

## Stack
- Bun runtime (faster than node for this)
- TypeScript with `--experimental-strip-types` if using node
- No build step
- No external deps (uses fetch + fs only)

## Honest caveats
- CallMeBot is unofficial WhatsApp. Can break. Telegram bot is fallback.
- Some ATS slugs were guessed - first run will reveal which need fixing.
- Big consultancies (Capgemini, Accenture, NTT) use SmartRecruiters/Workday - adapters not built yet.
