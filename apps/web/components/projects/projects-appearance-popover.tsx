'use client'

import { AppearancePopoverFrame, LayoutRow, CardSizeRow, ToggleRow } from './appearance-popover'
import { useProjectsViewStore } from '@/stores/projects-view-store'

/** Appearance options for the Projects page — only the ones that apply to project cards. */
export function ProjectsAppearancePopover() {
  const {
    layout, setLayout,
    cardSize, setCardSize,
    showCardInfo, setShowCardInfo,
  } = useProjectsViewStore()

  return (
    <AppearancePopoverFrame>
      <LayoutRow value={layout} onChange={setLayout} />

      {/* Card options — list rows have no cards */}
      {layout === 'grid' && (
        <>
          <CardSizeRow value={cardSize} onChange={setCardSize} />
          <ToggleRow label="Show Card Info" checked={showCardInfo} onCheckedChange={setShowCardInfo} />
        </>
      )}
    </AppearancePopoverFrame>
  )
}
