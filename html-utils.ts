/**
 * sources/html-utils.ts
 *
 * Helpers para limpiar HTML que vuelve de ATS APIs.
 * Compartido entre todos los adapters.
 */

export const stripHtml = (s: string): string =>
  s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

export const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&euro;/g, '€')
    .replace(/&hellip;/g, '…')
