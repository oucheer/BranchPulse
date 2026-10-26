import { expect, it } from 'vitest'
import { baseNamingIssue } from '../src-node/services/naming'

it('scratch output', () => {
  expect(baseNamingIssue('feature/pcie-band-crc')).toContain('_')
  expect(baseNamingIssue('feature/pcie-band-crc')).toContain('release')
  expect(baseNamingIssue('feature/pcie_band_crc')).toBeNull()
  expect(baseNamingIssue('feature/pcie_band_crc')).toBeNull()
  expect(baseNamingIssue('feature/pcie band')).not.toBeNull()
  expect(baseNamingIssue('develop/xc')).not.toBeNull()
})
