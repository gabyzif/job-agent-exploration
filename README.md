# Jobs Agent (modular)

Pipeline diario que busca roles senior FE en target companies EU/global, los puntúa con Claude, y te avisa por WhatsApp los matches >= 7/10.

## Arquitectura

```
sources/ (1 archivo por source)
   ├── ats-greenhouse.ts        US-centric tier 1 (slug-based)
   ├── ats-lever.ts             AI startups, Hevy (slug-based)
   ├── ats-ashby.ts             AI-native, design-eng (slug-based)
   ├── ats-smartrecruiters.ts   Consultoras grandes EU (slug-based)
   ├── ats-workable.ts          Scale-ups EU/Spain (slug-based)
   ├── ats-personio.ts          DACH + EU south (slug-based)
   ├── ats-teamtailor.ts        Nordics + Spain/PT (slug-based)
   ├── search-adzuna.ts         Search global, 1x/día (query-based)
   └── email-linkedin.ts        Gmail IMAP parser (email-based)
        ↓
   agent.ts (pipeline)
        ↓
   companies.ts (target list para ATS slug-based)
```

**3 tipos de source:**
- **ATS** (slug-based): monitorean companies específicas que VOS agregás a `companies.ts`
- **Search** (query-based): Adzuna busca con queries fijas y descubre companies nuevas
- **Email** (LinkedIn alerts): lee tu Gmail dedicado donde LinkedIn manda los Job Alerts

## Setup (15 min)

### 1. Bun
```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Estructura
```bash
mkdir -p ~/jobs-agent/sources
cd ~/jobs-agent
# copiá: agent.ts, companies.ts, sources/*.ts, README.md, CLAUDE.md
```

### 3. Anthropic API
console.anthropic.com → API Keys → cargá $5

### 4. Notificación (elegí una)

#### WhatsApp via CallMeBot (lo más simple)
1. Guardá `+34 644 51 95 23` como "CallMeBot"
2. Mandale: `I allow callmebot to send me messages`
3. Te responde con API key

#### Telegram (más confiable)
1. `@BotFather` en Telegram → `/newbot` → guardás el token
2. Hablale a tu bot, después: `https://api.telegram.org/bot{TOKEN}/getUpdates` → chat ID

### 5. `.env`
```bash
ANTHROPIC_API_KEY=sk-ant-...
WHATSAPP_PHONE=34XXXXXXXXX
CALLMEBOT_KEY=...

# Adzuna (opcional - descubre companies nuevas)
# Free tier: 250 requests/mes (el agente usa ~66/mes con throttle 1x/día)
ADZUNA_APP_ID=...
ADZUNA_APP_KEY=...

# LinkedIn email parser (opcional - lee Job Alerts via Gmail dedicado)
GMAIL_USER=tu-cuenta-agente@gmail.com
GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
```

### 5b. Adzuna setup (5 min, opcional)
1. https://developer.adzuna.com/ → Register (gratis, sin tarjeta)
2. Dashboard → te dan **App ID** + **App Key**
3. Copialos al `.env`

### 5c. LinkedIn email parser setup (15 min, opcional)

Esto te da cobertura del algoritmo de LinkedIn sin scraping (legal y estable).

**1) Crear Gmail dedicado al agente**
- gmail.com → Create account (algo como `tu-nombre.jobsagent@gmail.com`)
- No actives 2FA todavía (lo hacés en el paso 3)

**2) Configurar LinkedIn para mandar alerts a ese email**
- LinkedIn → Settings → Sign in & security → Email addresses → Add el nuevo email
- NO lo hagas primary
- Settings → Communications → Email frequency → cambiar destino de Job Alerts al nuevo email

**3) Configurar Job Alerts en LinkedIn**
- Mínimo 6 alerts cubriendo tus ángulos. Sugeridas para vos:
  - "Senior frontend engineer" - Barcelona
  - "Full stack" - Barcelona
  - "Frontend engineer" - EU (Remote)
  - "Senior software engineer" - Barcelona 25mi
  - "Design engineer" - EU (Remote)
  - "Product engineer" - EU (Remote)
  - "Staff frontend engineer" - EU (Remote)
  - "Senior full stack engineer" - Barcelona
- Frequency: Daily, via email

**4) App Password en Gmail nuevo**
- Login al Gmail nuevo
- Account → Security → 2-Step Verification → activar (obligatorio para App Passwords)
- Después: Security → App passwords → Generate → Name: "jobs-agent"
- Copiás el password de 16 caracteres (no se ve de nuevo)
- Lo pegás en `GMAIL_APP_PASSWORD` del `.env`

**5) Install dependencia**
```bash
bun add imapflow
```

Si no configurás estas envs, el agente skipea LinkedIn silenciosamente.

### 6. Primera corrida (test mode)
```bash
cd ~/jobs-agent
export $(cat .env | xargs)
bun agent.ts
```

Esperá:
- Logs por company: `✓ Miro (greenhouse): 47` o `✗ Capgemini (smartrecruiters): 404`
- Fix los slugs rotos en `companies.ts`
- Lista de triage scores
- Notificación WhatsApp si hay deep matches >= 7

⚠️ **Primera corrida marca todo como visto**. La segunda en adelante solo procesa jobs nuevos.

### 7. Cron en Mac (11h, 16h, 20h L-V)

```bash
crontab -e
```

```cron
0 11,16,20 * * 1-5 cd /Users/TU_USUARIO/jobs-agent && /Users/TU_USUARIO/.bun/bin/bun agent.ts >> agent.log 2>&1
```

`which bun` para path real. macOS: Privacy → Full Disk Access → `/usr/sbin/cron`.

## Mantener vivo

- **Slug roto**: log dice `✗ X (workable): 404` → editás `companies.ts`
- **Nueva company**: una línea en `companies.ts` (necesita: name, ats, slug)
- **Nuevo ATS provider**: crear `sources/ats-{name}.ts` + agregarlo a `sources/index.ts` + tipo en `sources/types.ts`
- **Ajustar criterio scoring**: editás `PROFILE` o rubric en `enrichJob` prompt en `agent.ts`

## Verificar slugs antes de agregar companies

| ATS | URL pattern para verificar |
|---|---|
| greenhouse | https://boards-api.greenhouse.io/v1/boards/{slug}/jobs |
| lever | https://api.lever.co/v0/postings/{slug} |
| ashby | https://api.ashbyhq.com/posting-api/job-board/{slug} |
| smartrecruiters | https://api.smartrecruiters.com/v1/companies/{slug}/postings |
| workable | https://apply.workable.com/api/v1/widget/accounts/{slug} |
| personio | https://{slug}.jobs.personio.de/xml |
| teamtailor | https://{slug}.teamtailor.com/jobs.json |

Si abrís la URL y ves JSON/XML con jobs = slug correcto.

## Costos estimados

Cascada Haiku → Sonnet:
- Triage Haiku: ~$0.0008/job
- Deep Sonnet: ~$0.012/job (solo top, ~20% de jobs)

Estimado mensual con ~25 companies y 50 jobs/día filtrados:
- Triage: ~$1/mes
- Deep: ~$2.50/mes
- **Total: ~$3.50/mes**

Ajustes:
- `DEEP_ENRICH_THRESHOLD = 8` → menos a Sonnet → ~$2/mes pero perdés borderlines
- `DEEP_ENRICH_THRESHOLD = 6` → más a Sonnet → ~$5/mes con mejor recall
- CallMeBot/Telegram: gratis

## Honest caveats

- **Slugs de SmartRecruiters/Workable/Personio**: muchos puestos como placeholders. Primera corrida revelará cuáles necesitan fix.
- **CallMeBot es unofficial WhatsApp**. Telegram es fallback más confiable.
- **No incluye**: GitLab, Stripe, Vercel, Figma, Factorial (ATS propios - skip por ahora).
- **No incluye scraping**: agente solo usa APIs públicas. No viola ToS de nadie.
- **No usa LinkedIn**: LinkedIn cerró sus APIs públicas de jobs. Si necesitás cobertura LinkedIn, configurá Job Alerts en LI y parseá los emails (no implementado todavía).
# job-agent-exploration
