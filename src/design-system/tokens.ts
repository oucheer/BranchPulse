/**
 * BranchPulse Design System — Global Tokens
 * Single source of truth for all visual primitives.
 * Business pages must reference these tokens, never hardcode values.
 */

// ─── Color ───────────────────────────────────────────────────────────────────

export const color = {
  canvas: '#F7F8FA',
  surface: '#FFFFFF',
  surfaceSecondary: '#F3F4F6',
  primary: '#F97316',
  accent: '#7C5CFC',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
  info: '#3B82F6',
  muted: '#6B7280',
  border: '#E5E7EB'
} as const

// ─── Typography ──────────────────────────────────────────────────────────────

export const typography = {
  display: { fontSize: '28px', fontWeight: 700, lineHeight: '36px', letterSpacing: '-0.02em' },
  h1: { fontSize: '20px', fontWeight: 700, lineHeight: '28px', letterSpacing: '-0.015em' },
  h2: { fontSize: '16px', fontWeight: 600, lineHeight: '24px', letterSpacing: '-0.01em' },
  h3: { fontSize: '14px', fontWeight: 600, lineHeight: '20px', letterSpacing: '0' },
  body: { fontSize: '14px', fontWeight: 400, lineHeight: '20px', letterSpacing: '0' },
  bodySmall: { fontSize: '13px', fontWeight: 400, lineHeight: '18px', letterSpacing: '0' },
  label: { fontSize: '12px', fontWeight: 500, lineHeight: '16px', letterSpacing: '0.01em' },
  caption: { fontSize: '11px', fontWeight: 400, lineHeight: '14px', letterSpacing: '0.01em' },
  code: { fontSize: '13px', fontWeight: 400, lineHeight: '18px', letterSpacing: '0', fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace' }
} as const

// ─── Spacing ─────────────────────────────────────────────────────────────────

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48
} as const

// ─── Radius ──────────────────────────────────────────────────────────────────

export const radius = {
  button: 8,
  input: 8,
  card: 12,
  dialog: 16,
  floating: 18,
  badge: 999
} as const

// ─── Border ──────────────────────────────────────────────────────────────────

export const border = {
  default: '1px solid rgb(var(--line))',
  accent: '1px solid rgb(var(--primary) / 0.35)',
  focus: '1px solid rgb(var(--primary) / 0.55)'
} as const

// ─── Shadow ──────────────────────────────────────────────────────────────────

export const shadow = {
  /** Default: barely-there, border-first elevation */
  sm: '0 1px 2px rgb(0 0 0 / 0.04)',
  /** Hover: subtle lift */
  md: '0 2px 8px rgb(0 0 0 / 0.06)',
  /** Floating layer: visible but soft, no heavy drop */
  lg: '0 8px 24px -6px rgb(0 0 0 / 0.10), 0 4px 12px -4px rgb(0 0 0 / 0.06)',
  /** Modal / Command Palette */
  xl: '0 16px 48px -12px rgb(0 0 0 / 0.14), 0 8px 20px -8px rgb(0 0 0 / 0.08)',
  /** Primary button hover glow (restrained) */
  glowPrimary: '0 0 0 1px rgb(var(--primary) / 0.20), 0 4px 14px -4px rgb(var(--primary) / 0.25)'
} as const

// ─── Elevation (z-index scale) ───────────────────────────────────────────────

export const elevation = {
  background: 0,
  ambient: 1,
  shell: 10,
  workspace: 20,
  surface: 30,
  floating: 40,
  modal: 50,
  toast: 60
} as const

// ─── Motion ──────────────────────────────────────────────────────────────────

export const motion = {
  /** Hover, active, small feedback */
  fast: { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] as const },
  /** Standard enter/exit, panel transitions */
  normal: { duration: 0.20, ease: [0.25, 0.46, 0.45, 0.94] as const },
  /** Large surface, page-level transitions */
  slow: { duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] as const },
  /** Reserved for sidebar indicator + major navigation only */
  spring: { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.8 }
} as const

// ─── Layout ──────────────────────────────────────────────────────────────────

export const layout = {
  sidebarWidth: 248,
  topbarHeight: 52
} as const

// ─── Ambient Background ──────────────────────────────────────────────────────

export const ambient = {
  speed: 0.14,
  density: 6,
  opacity: 0.06,
  glowIntensity: 0.03,
  pointerRepel: 28,
  cursorRepelStrength: 0.06
} as const