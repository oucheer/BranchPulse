import { describe, expect, it } from 'vitest'
import { resolveSmtpPreset } from '../src/lib/emailPresets'

describe('resolveSmtpPreset', () => {
  it('maps personal outlook domains to the consumer SMTP host', () => {
    expect(resolveSmtpPreset('someone@outlook.com')).toEqual({
      server: 'smtp-mail.outlook.com',
      port: 587,
      secure: false,
      tls: true
    })
  })

  it('maps corporate outlook domains to Microsoft 365', () => {
    expect(resolveSmtpPreset('abc.123@pantum.local')).toEqual({
      server: 'smtp.office365.com',
      port: 587,
      secure: false,
      tls: true
    })
  })

  it('returns null when the address has no domain', () => {
    expect(resolveSmtpPreset('not-an-email')).toBeNull()
  })
})
