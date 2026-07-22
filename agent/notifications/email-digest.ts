type NeedsDescriptionCandidate = {
  company: string
  title: string
  location: string
  url: string
  predicted: {
    fitScore: number
    matchType: string
    redFlags: string[]
    greenFlags?: string[]
    reason: string
  }
}

type TopMatch = {
  company: string
  title: string
  location: string
  url: string
  source: string
  fitScore: number
  matchType: string
  whyMatch: string
  hiddenMatch: string | null
  redFlags: string[]
}

const normalizeGmailAppPassword = (pass: string) =>
  pass.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '')

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const renderTopText = (matches: TopMatch[]) =>
  matches.flatMap((match, index) => [
    `${index + 1}. ${match.fitScore}/10 ${match.matchType} ${match.company} - ${match.title}`,
    `   ${match.location} | ${match.source}`,
    `   ${match.url}`,
    `   why: ${match.whyMatch}`,
    match.hiddenMatch ? `   hidden: ${match.hiddenMatch}` : '',
    `   red: ${match.redFlags.join(', ') || '-'}`,
    '',
  ])

const renderNeedsDescriptionText = (candidates: NeedsDescriptionCandidate[]) =>
  candidates.flatMap((candidate, index) => [
    `${index + 1}. ${candidate.predicted.fitScore}/10 ${candidate.company} - ${candidate.title}`,
    `   ${candidate.location}`,
    `   ${candidate.url}`,
    `   green: ${(candidate.predicted.greenFlags ?? []).join(', ') || '-'}`,
    `   red: ${candidate.predicted.redFlags.join(', ') || '-'}`,
    '',
  ])

const renderTextDigest = ({
  topMatches,
  needsDescription,
}: {
  topMatches: TopMatch[]
  needsDescription: NeedsDescriptionCandidate[]
}) =>
  [
    `Jobs Agent Digest`,
    '',
    `Top matches (${topMatches.length})`,
    '',
    ...renderTopText(topMatches),
    `Needs description (${needsDescription.length})`,
    '',
    ...renderNeedsDescriptionText(needsDescription),
  ].join('\n')

const renderCard = ({
  eyebrow,
  title,
  location,
  url,
  cta,
  body,
}: {
  eyebrow: string
  title: string
  location: string
  url: string
  cta: string
  body: string
}) => `
  <div style="border: 1px solid #d9e2ec; border-radius: 12px; padding: 14px 16px; margin: 0 0 12px;">
    <div style="font-size: 13px; color: #52606d;">${escapeHtml(eyebrow)}</div>
    <h3 style="margin: 4px 0 4px; font-size: 17px;">${escapeHtml(title)}</h3>
    <div style="margin-bottom: 8px; color: #52606d;">${escapeHtml(location)}</div>
    <div style="margin-bottom: 8px;">
      <a href="${escapeHtml(url)}" style="color: #0967d2;">${escapeHtml(cta)}</a>
    </div>
    ${body}
  </div>
`

const renderHtmlDigest = ({
  topMatches,
  needsDescription,
}: {
  topMatches: TopMatch[]
  needsDescription: NeedsDescriptionCandidate[]
}) => `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.45; color: #1f2933;">
    <h2 style="margin: 0 0 12px;">Jobs Agent Digest</h2>
    <p style="margin: 0 0 18px;">Top evaluated matches and LinkedIn cards that need manual description.</p>

    <h3 style="margin: 24px 0 12px;">Top matches (${topMatches.length})</h3>
    ${
      topMatches.length === 0
        ? '<p style="color: #52606d;">No evaluated top matches this run.</p>'
        : topMatches
            .map((match) =>
              renderCard({
                eyebrow: `${match.fitScore}/10 · ${match.matchType} · ${match.source}`,
                title: `${match.company} · ${match.title}`,
                location: match.location,
                url: match.url,
                cta: 'Open job',
                body: `
                  <div style="font-size: 13px;"><strong>Why:</strong> ${escapeHtml(match.whyMatch)}</div>
                  ${
                    match.hiddenMatch
                      ? `<div style="font-size: 13px;"><strong>Hidden match:</strong> ${escapeHtml(match.hiddenMatch)}</div>`
                      : ''
                  }
                  <div style="font-size: 13px;"><strong>Red:</strong> ${escapeHtml(match.redFlags.join(', ') || '-')}</div>
                `,
              }),
            )
            .join('')
    }

    <h3 style="margin: 24px 0 12px;">Needs description (${needsDescription.length})</h3>
    ${
      needsDescription.length === 0
        ? '<p style="color: #52606d;">No LinkedIn cards need manual description this run.</p>'
        : needsDescription
            .map((candidate) =>
              renderCard({
                eyebrow: `${candidate.predicted.fitScore}/10 · ${candidate.predicted.matchType}`,
                title: `${candidate.company} · ${candidate.title}`,
                location: candidate.location,
                url: candidate.url,
                cta: 'Open LinkedIn job',
                body: `
                  <div style="font-size: 13px;"><strong>Green:</strong> ${escapeHtml((candidate.predicted.greenFlags ?? []).join(', ') || '-')}</div>
                  <div style="font-size: 13px;"><strong>Red:</strong> ${escapeHtml(candidate.predicted.redFlags.join(', ') || '-')}</div>
                `,
              }),
            )
            .join('')
    }
  </div>
`

export const sendJobsDigest = async ({
  topMatches,
  needsDescription,
  gmailUser,
  gmailAppPassword,
  to = gmailUser,
}: {
  topMatches: TopMatch[]
  needsDescription: NeedsDescriptionCandidate[]
  gmailUser: string
  gmailAppPassword: string
  to?: string
}) => {
  if (topMatches.length === 0 && needsDescription.length === 0) {
    return { sent: false, reason: 'No candidates.' }
  }
  if (!gmailUser || !gmailAppPassword || !to) {
    return { sent: false, reason: 'Missing Gmail envs.' }
  }

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: gmailUser,
      pass: normalizeGmailAppPassword(gmailAppPassword),
    },
  })

  await transporter.sendMail({
    from: `"Jobs Agent" <${gmailUser}>`,
    to,
    subject: `Jobs Agent: ${topMatches.length} top matches, ${needsDescription.length} need description`,
    text: renderTextDigest({ topMatches, needsDescription }),
    html: renderHtmlDigest({ topMatches, needsDescription }),
  })

  return { sent: true, to }
}
