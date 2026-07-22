/**
 * sources/email-linkedin.ts
 *
 * Lee emails de LinkedIn Job Alerts via IMAP (Gmail dedicado) y los parsea
 * como source más del agente.
 *
 * Setup:
 *   1. Gmail dedicado con 2FA activado
 *   2. App Password generado (Account → Security → App passwords)
 *   3. envs: GMAIL_USER, GMAIL_APP_PASSWORD
 *   4. LinkedIn alerts configuradas para mandar email a ese Gmail
 *
 * Cómo funciona:
 *   - Conecta a Gmail IMAP (imap.gmail.com:993)
 *   - Busca emails de jobs-noreply@linkedin.com y jobalerts-noreply@linkedin.com
 *   - De las últimas 24h (configurable)
 *   - Parsea HTML del email extrayendo: job title, company, location, URL
 *   - Marca emails como leídos para no procesar dos veces
 *   - Devuelve RawJob[] compatible con el resto del pipeline
 *
 */

import { stripHtml, decodeHtml } from './html-utils.ts'
import type { RawJob } from './types.ts'

type LinkedInJobAlert = {
  emailId: string
  receivedAt: Date
  htmlBody: string
}

type ParsedEmail = {
  html?: string | false
  textAsHtml?: string
  text?: string
}

const LINKEDIN_SENDERS = [
  'jobs-noreply@linkedin.com',
  'jobalerts-noreply@linkedin.com',
  'jobs-listings@linkedin.com',
]

const formatImapError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)

  const details = error as Error & {
    code?: string
    response?: string
    responseText?: string
    serverResponse?: string
    authenticationFailed?: boolean
  }
  const parts = [
    error.message,
    details.code && `code=${details.code}`,
    details.response && `response=${details.response}`,
    details.responseText && `responseText=${details.responseText}`,
    details.serverResponse && `serverResponse=${details.serverResponse}`,
    details.authenticationFailed && 'authenticationFailed=true',
  ].filter(Boolean)

  return parts.join(' | ')
}

const normalizeGmailAppPassword = (pass: string) =>
  pass.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '')

/**
 * Conecta a Gmail IMAP y trae los emails de LinkedIn de las últimas N horas.
 */
const fetchLinkedInEmails = async (
  user: string,
  pass: string,
  hoursBack = 24,
): Promise<LinkedInJobAlert[]> => {
  const { ImapFlow } = await import('imapflow')
  const normalizedPass = normalizeGmailAppPassword(pass)
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass: normalizedPass },
    logger: false,
  })

  try {
    await client.connect()
  } catch (error) {
    throw new Error(
      `Gmail IMAP connect failed: ${formatImapError(error)}. Check that Gmail IMAP is enabled, 2FA is on, and GMAIL_APP_PASSWORD is a 16-character App Password without the account password.`,
    )
  }
  const emails: LinkedInJobAlert[] = []

  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000)

      // Buscar emails de LinkedIn senders, no leídos, desde X horas atrás
      for (const sender of LINKEDIN_SENDERS) {
        const messages = await client.search({
          from: sender,
          since,
        })

        for (const uid of messages) {
          const message = await client.fetchOne(uid.toString(), {
            envelope: true,
            source: true,
          })

          if (!message || !message.source) continue

          // Extraer HTML body del raw MIME. LinkedIn/Gmail suelen usar
          // quoted-printable o base64, así que un regex sobre raw source falla.
          const raw = message.source.toString('utf-8')
          const { simpleParser } = await import('mailparser')
          const parsed = (await simpleParser(raw)) as ParsedEmail
          const htmlBody = typeof parsed.html === 'string'
            ? parsed.html
            : parsed.textAsHtml ?? parsed.text ?? raw

          emails.push({
            emailId: String(uid),
            receivedAt: message.envelope?.date ?? new Date(),
            htmlBody,
          })
        }
      }
    } catch (error) {
      throw new Error(`Gmail IMAP read failed: ${formatImapError(error)}`)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }

  return emails
}

/**
 * Parsea el HTML de un email de LinkedIn Job Alert.
 * LinkedIn cambia el HTML seguido, así que esto es best-effort con varios patterns.
 */
export const parseLinkedInEmail = (email: LinkedInJobAlert): RawJob[] => {
  const jobs: RawJob[] = []

  // Pattern principal: los emails de LinkedIn marcan el link textual de cada card
  // con tracking "jobcard_body_{jobId}". Eso evita confundir logo/apply/see-all links.
  const jobIds = [
    ...new Set([...email.htmlBody.matchAll(/jobcard_body_(\d+)/g)].map((match) => match[1])),
  ]

  for (const markerJobId of jobIds) {
    const markerIndex = email.htmlBody.indexOf(`jobcard_body_${markerJobId}`)
    if (markerIndex === -1) continue

    const anchorStart = email.htmlBody.lastIndexOf('<a ', markerIndex)
    const anchorEnd = email.htmlBody.indexOf('</a>', markerIndex)
    if (anchorStart === -1 || anchorEnd === -1) continue

    const anchor = email.htmlBody.slice(anchorStart, anchorEnd + 4)
    const href = anchor.match(/href="([^"]+)"/)?.[1]
    const hrefJobId = href?.match(/\/jobs\/view\/(\d+)/)?.[1]
    const jobId = hrefJobId ?? markerJobId
    const title = decodeHtml(stripHtml(anchor)).trim()

    // Justo después del título viene un <p> con "Company · Location".
    const afterAnchor = email.htmlBody.slice(anchorEnd, anchorEnd + 1000)
    const decodedAfterAnchor = decodeHtml(afterAnchor)
    const companyMatch = decodedAfterAnchor.match(
      /<(?:p|span|td)[^>]*>\s*([^<]+?)\s*·\s*([^<]+?)\s*<\/(?:p|span|td)>/,
    )
    const company = companyMatch ? stripHtml(companyMatch[1]) : ''
    const location = companyMatch ? stripHtml(companyMatch[2]) : ''

    if (!href || !title || !company) continue

    const dedupeId = `li-${jobId}`
    if (jobs.find((j) => j.id === dedupeId)) continue

    jobs.push({
      id: dedupeId,
      title,
      company,
      location,
      url: decodeHtml(href).split('?')[0],
      description: '', // LinkedIn emails no traen description completa.
      postedAt: email.receivedAt.toISOString(),
    } as RawJob & { company: string })
  }

  return jobs.map((j: any) => ({ ...j, company: (j as any).company || 'LinkedIn' })) as RawJob[]
}

/**
 * Entry point: lee emails de LinkedIn de las últimas 24h y devuelve jobs.
 *
 * NOTA: los jobs de LinkedIn no traen descripción completa en el email.
 * Solo title, company, location, URL. El triage de Haiku puede decidir
 * con poca info; si pasa a deep enrichment, va a tener que trabajar con
 * eso o agregar un fetch del job URL (futuro).
 */
export const fetchLinkedInAlerts = async (
  user: string,
  pass: string,
): Promise<(RawJob & { company: string })[]> => {
  if (!user || !pass) {
    throw new Error('Faltan GMAIL_USER / GMAIL_APP_PASSWORD en envs')
  }

  const emails = await fetchLinkedInEmails(user, pass, 24)
  console.error(`  fetched ${emails.length} LinkedIn emails`)

  const allJobs = emails.flatMap(parseLinkedInEmail)

  // Dedupe por jobId (mismo job aparece en varios emails de distintas alerts)
  const seen = new Set<string>()
  const unique = allJobs.filter((j) => {
    if (seen.has(j.id)) return false
    seen.add(j.id)
    return true
  }) as (RawJob & { company: string })[]

  console.error(`  parsed ${unique.length} unique jobs from emails`)
  return unique
}
