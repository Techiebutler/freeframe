export const GRADIENT_PRESETS = [
  'from-violet-600 via-purple-600 to-fuchsia-500',
  'from-blue-600 via-indigo-600 to-violet-500',
  'from-emerald-600 via-teal-600 to-cyan-500',
  'from-orange-500 via-amber-500 to-yellow-500',
  'from-rose-600 via-pink-600 to-fuchsia-500',
  'from-cyan-500 via-blue-500 to-indigo-500',
  'from-sky-500 via-cyan-400 to-teal-400',
  'from-pink-500 via-rose-500 to-orange-400',
]

export function getGradientForProject(projectId: string): string {
  const hash = projectId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return GRADIENT_PRESETS[hash % GRADIENT_PRESETS.length]
}
