export interface SmtpPreset {
  server: string
  port: number
  secure: boolean
  tls: boolean
}

const CONSUMER_OUTLOOK_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com'])
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export function resolveSmtpPreset(address: string): SmtpPreset | null {
  const domain = address.trim().split('@')[1]?.toLowerCase().replace(/\.+$/, '')
  if (!domain) return null

  if (CONSUMER_OUTLOOK_DOMAINS.has(domain)) {
    return { server: 'smtp-mail.outlook.com', port: 587, secure: false, tls: true }
  }
  if (GMAIL_DOMAINS.has(domain)) {
    return { server: 'smtp.gmail.com', port: 587, secure: false, tls: true }
  }

  // Corporate Outlook accounts (e.g. name@pantum.local) usually go through Microsoft 365.
  return { server: 'smtp.office365.com', port: 587, secure: false, tls: true }
}
