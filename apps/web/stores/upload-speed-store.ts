import { create } from 'zustand'
import type { UploadRate } from '@/lib/upload-speed'

/**
 * Each running upload's speed and time left, by upload row id.
 *
 * Kept out of the upload store on purpose. Every write there goes through
 * `persist` into localStorage -- read, parsed and merged each time -- and
 * re-renders every tab watching it, which is why progress is only written when
 * the whole percent moves. A rate changes every second, belongs to the one tab
 * doing the transfer, and means nothing after a reload.
 */
interface UploadSpeedStore {
  rates: Record<string, UploadRate>
  /** Null withdraws the figure for that row. */
  setRate: (id: string, rate: UploadRate | null) => void
}

export const useUploadSpeedStore = create<UploadSpeedStore>((set) => ({
  rates: {},
  setRate: (id, rate) =>
    set((state) => {
      if (rate === null) {
        if (!(id in state.rates)) return state
        const { [id]: _gone, ...rest } = state.rates
        return { rates: rest }
      }
      return { rates: { ...state.rates, [id]: rate } }
    }),
}))
