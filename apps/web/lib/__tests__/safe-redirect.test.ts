import { describe, it, expect } from 'vitest'
import { safeInternalPath } from '@/lib/safe-redirect'

describe('safeInternalPath', () => {
  it('returns a valid app-absolute path unchanged', () => {
    expect(safeInternalPath('/projects')).toBe('/projects')
    expect(safeInternalPath('/projects/abc?tab=comments')).toBe('/projects/abc?tab=comments')
    expect(safeInternalPath('/a/b/c#x')).toBe('/a/b/c#x')
  })

  it('falls back when there is no target', () => {
    expect(safeInternalPath(null)).toBe('/projects')
    expect(safeInternalPath(undefined)).toBe('/projects')
    expect(safeInternalPath('')).toBe('/projects')
  })

  it('rejects absolute URLs with a scheme', () => {
    expect(safeInternalPath('https://evil.example/phish')).toBe('/projects')
    expect(safeInternalPath('http://evil.example')).toBe('/projects')
    expect(safeInternalPath('javascript:localStorage.clear()')).toBe('/projects')
    expect(safeInternalPath('JaVaScRiPt:alert(1)')).toBe('/projects')
    expect(safeInternalPath('data:text/html,<script>1</script>')).toBe('/projects')
  })

  it('rejects protocol-relative targets, including backslash variants', () => {
    expect(safeInternalPath('//evil.example/x')).toBe('/projects')
    expect(safeInternalPath('/\\evil.example')).toBe('/projects')
    expect(safeInternalPath('/\\/evil.example')).toBe('/projects')
  })

  it('rejects targets with control characters or whitespace', () => {
    expect(safeInternalPath('/proj\tects')).toBe('/projects')
    expect(safeInternalPath('/\n//evil.example')).toBe('/projects')
    expect(safeInternalPath('/ /evil')).toBe('/projects')
    expect(safeInternalPath('\u0000/x')).toBe('/projects')
  })

  it('honours an explicit fallback', () => {
    expect(safeInternalPath(null, '/setup')).toBe('/setup')
    expect(safeInternalPath('https://evil.example', '/setup')).toBe('/setup')
  })
})
