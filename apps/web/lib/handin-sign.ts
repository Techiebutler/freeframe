/** "Veda – Black Friday UGC 3 – Hook 4" under the title "Veda – Black Friday UGC 3" reads "Hook 4": a tile shows what differs. */
export const shortName = (name: string, title: string): string =>
  (title && name.startsWith(title) ? name.slice(title.length).replace(/^[\s–—\-:·|]+/, '') : '') || name
