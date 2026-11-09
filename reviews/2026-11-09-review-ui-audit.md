# Review/decision UI audit, 2026-11-09

Method: code audit against ux-laws, apple-hig, emil-design-eng. No browser harness (no Playwright in the repo; views need a login or share token), so widths 375/390/768/1280 were reasoned from the markup and flex math, not screenshots. Arithmetic for the headline bug at 375 px: bar = 375 - 24 padding - 16 gaps = 335; attach 56 + finish "Send to agent" about 150 leaves about 129 for Comment; minus 40 padding, 24 icon, 8 gap = about 57 px for a 70 px word, so it clipped to "Commen".

| View | Defect | Status |
|---|---|---|
| flow-view phone | "Comment" label clipped (finish button `shrink-0`, comment `min-w-0`) | Fixed: Comment `min-w-[7.5rem]` + `whitespace-nowrap`, finish button shrinks and truncates its label, icon 24 to 20 |
| flow-view desktop | Attach and Add-note icon buttons 36 px, Exit 36 px | Fixed: 44 px |
| flow-view | Long `finishLabel` (German) could push the bar | Fixed by the same truncate |
| flow-view | "Talk" (desktop) vs "Comment" (phone) for the same action | Open (taste) |
| static-review | Numbered pins 28 px hit area | Fixed: 44 px invisible hit area |
| static-review | Loading spinner `aria-label` on svg without role | Fixed: `role="img"` |
| static-review | Phone: aside is 38dvh, notes list gets about 55 px at 375x667 | Open (taste/layout) |
| folder-share-viewer (asset view) | Back button 28 px and unlabeled; Download 28 px | Fixed: 44 px on phone, `aria-label` |
| folder-share-viewer (folder header) | Panel toggle 28 px, title only; Download All 28 px, `text-white` literal | Fixed: 44 px on phone, `aria-label`, `text-text-inverse` |
| folder-share-viewer (tiles) | Download overlay 24 px and hover-only (invisible on touch) | Fixed: visible on touch, 44 px on coarse pointers, keyboard focus reveals it, label |
| share/[token]/page | Back button 28 px unlabeled; Download 28 px; Approve/Reject 32 px; password input 36 px with 14 px text (iOS zoom) | Fixed |
| share/[token]/page | Whole page uses zinc/white/purple/green literals instead of tokens | Open (large refactor) |
| approval-bar | Approve / Reject / Cancel 32 px | Fixed: 44 px on phone, 32 px on md+ |
| version-switcher, guest-comment-input | 32 px trigger / submit | Fixed same way |
| ui/Button `sm` | h-8 everywhere | Open: change in the shared component is app-wide, so only the review views were patched |
| Decision UI component | None exists in apps/web (grep for decision) | n/a |
