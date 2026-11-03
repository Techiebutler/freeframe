import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RequestWorkspace, SubmissionSuccess } from '../request-workspace'
import type { RequestAsset } from '@/lib/platform'
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: ({ initialStreamUrl, comments }: { initialStreamUrl: string; comments: { author: { id: string; name: string } }[] }) => <div data-testid="player" data-author={comments?.[0]?.author.name} data-author-id={comments?.[0]?.author.id}>{initialStreamUrl}</div> }))
afterEach(cleanup)
it('keeps playback stable across signed URL rotations but switches on a new version', () => {
  const asset: RequestAsset = { asset_id: 'a', name: 'Cut', version: 1, version_id: 'v1', processing: 'ready', review_state: 'held', comments: [], media_url: 'https://media.test/cut.mp4?signature=one' }
  const props = { token: 't', onSelect: vi.fn(), onRefresh: vi.fn() }
  const { rerender } = render(<RequestWorkspace {...props} assets={[asset]} />)
  rerender(<RequestWorkspace {...props} assets={[{ ...asset, media_url: 'https://media.test/cut.mp4?signature=two' }]} />)
  expect(screen.getByTestId('player')).toHaveTextContent('signature=one')
  rerender(<RequestWorkspace {...props} assets={[{ ...asset, version: 2, version_id: 'v2', media_url: 'https://media.test/cut.mp4?signature=three' }]} />)
  expect(screen.getByTestId('player')).toHaveTextContent('signature=three')
})

it('keeps review activity compact and separate from the completion mascot', () => {
  render(<RequestWorkspace token="t" assets={[]} onSelect={vi.fn()} onRefresh={vi.fn()} />)
  expect(screen.getByText('Review in progress')).toBeVisible()
  expect(screen.queryByRole('img', { name: /robot|assistant/i })).toBeNull()
  expect(document.querySelector('.review-analysis')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Pause animation' }))
  expect(document.querySelector('.review-analysis')).toHaveAttribute('data-paused', 'true')
  expect(screen.getByText('Review in progress')).toBeVisible()
})

it('celebrates only the first completed visit and keeps a video completion cue', () => {
  localStorage.removeItem('request-celebrated:completion-test')
  const { unmount } = render(<SubmissionSuccess token="completion-test" brand="Northline" />)
  expect(document.querySelector('.request-confetti')).not.toBeNull()
  expect(screen.getByLabelText('Video submitted')).toBeVisible()
  unmount()
  render(<SubmissionSuccess token="completion-test" brand="Northline" />)
  expect(document.querySelector('.request-confetti')).toBeNull()
  expect(screen.getByText('Your ads were submitted')).toBeVisible()
})

it('shows a frozen source frame during review and only mounts playback after feedback is ready', () => {
  const asset: RequestAsset = { asset_id: 'a', name: 'Cut', version: 1, version_id: 'v1', processing: 'ready', review_state: 'reviewing', comments: [], media_url: '/cut.mp4' }
  const props = { token: 't', onSelect: vi.fn(), onRefresh: vi.fn() }
  const { rerender } = render(<RequestWorkspace {...props} assets={[asset]} />)
  expect(screen.queryByTestId('player')).toBeNull()
  const preview = document.querySelector('video')!
  expect(preview).toHaveAttribute('src', '/cut.mp4')
  expect(preview.controls).toBe(false)
  const pause = vi.spyOn(preview, 'pause').mockImplementation(() => {})
  fireEvent.play(preview)
  expect(pause).toHaveBeenCalled()
  rerender(<RequestWorkspace {...props} assets={[{ ...asset, review_state: 'held' }]} />)
  expect(screen.getByTestId('player')).toBeVisible()
  expect(document.querySelector('.review-analysis')).toBeNull()
})

it('uses the existing thumbnail without downloading video, and falls back if it fails', () => {
  render(<RequestWorkspace token="t" assets={[{ asset_id: 'a', name: 'Cut', version: 1, processing: 'ready', review_state: 'reviewing', comments: [], media_url: '/cut.mp4', thumbnail_url: '/cut.jpg' }]} onSelect={vi.fn()} onRefresh={vi.fn()} />)
  expect(screen.getByAltText('Still frame of your submitted video')).toHaveAttribute('src', '/cut.jpg')
  expect(document.querySelector('video')).toBeNull()
  fireEvent.error(screen.getByAltText('Still frame of your submitted video'))
  expect(document.querySelector('video')).toHaveAttribute('src', '/cut.mp4')
})


it('uses the request brand for comment and player attribution without changing the agent identity', () => {
  const asset: RequestAsset = { asset_id: 'a', name: 'Cut', version: 1, processing: 'ready', review_state: 'held', media_url: '/cut.mp4', comments: [{ t: 1, body: 'Hold the end card.' }] }
  const props = { token: 't', assets: [asset], onSelect: vi.fn(), onRefresh: vi.fn() }
  const { rerender } = render(<RequestWorkspace {...props} brand=" Northline " />)
  expect(screen.getByText('Northline')).toBeVisible()
  expect(screen.getByTestId('player')).toHaveAttribute('data-author', 'Northline')
  expect(screen.getByTestId('player')).toHaveAttribute('data-author-id', 'review-agent')
  rerender(<RequestWorkspace {...props} brand="  " />)
  expect(screen.getByText('Review team')).toBeVisible()
  expect(screen.getByTestId('player')).toHaveAttribute('data-author', 'Review team')
})



it('lets the editor replace a failed submitted version on the same asset', () => {
  const asset: RequestAsset = { asset_id: 'cut', name: 'Cut', version: 2, version_id: 'v2', processing: 'failed', review_state: 'unavailable', comments: [] }
  const revise = vi.fn()
  render(<RequestWorkspace token="failed-test" assets={[asset]} onSelect={vi.fn()} onRefresh={vi.fn()} onRevise={revise} />)
  expect(screen.getByText('Review unavailable')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Upload a replacement v3' }))
  expect(revise).toHaveBeenCalledWith(asset)
})

it('parks scanning after one cycle while real stage, measured expectation and elapsed remain visible', () => {
  vi.useFakeTimers()
  try {
    const asset: RequestAsset = {asset_id:'a',name:'Cut',version:1,version_id:'v1',processing:'ready',review_state:'reviewing',comments:[],review_progress:{stage:'reading',step:'analysing',startedAgoSeconds:30,estimate:{lowerSeconds:90,upperSeconds:180,sampleCount:12}}}
    const {rerender}=render(<RequestWorkspace token="t" assets={[asset]} onSelect={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText('Checking the video')).toBeVisible()
    expect(screen.getByText('Analysis usually 1.5–3 min')).toBeVisible()
    expect(document.querySelector('.review-analysis')).toHaveAttribute('data-scanning','true')
    act(()=>vi.advanceTimersByTime(4000))
    expect(document.querySelector('.review-analysis')).toHaveAttribute('data-scanning','false')
    expect(screen.getByText('0:34 elapsed')).toBeVisible()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow','100')
    rerender(<RequestWorkspace token="t" assets={[{...asset,review_progress:{...asset.review_progress!,step:'finishing'}}]} onSelect={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText('Preparing feedback')).toBeVisible()
  } finally {vi.useRealTimers()}
})
it('makes queue time and an analysis overrun explicit without inventing a completion', () => {
  const asset: RequestAsset={asset_id:'a',name:'Cut',version:1,processing:'ready',review_state:'reviewing',comments:[],review_progress:{stage:'waiting',estimate:{lowerSeconds:120,upperSeconds:180,sampleCount:12}}}
  const props={token:'t',onSelect:vi.fn(),onRefresh:vi.fn()}
  const {rerender}=render(<RequestWorkspace {...props} assets={[asset]} />)
  expect(screen.getByText('Waiting for review')).toBeVisible()
  expect(screen.getByText(/queue time and feedback publication are additional/)).toBeVisible()
  rerender(<RequestWorkspace {...props} assets={[{...asset,review_progress:{...asset.review_progress!,stage:'reading',step:'analysing',startedAgoSeconds:200}}]} />)
  expect(screen.getByText(/Taking longer than usual/)).toBeVisible()
  expect(screen.queryByTestId('player')).toBeNull()
})

it('stops cached review motion on a status outage and resumes on recovery', () => {
  const asset: RequestAsset={asset_id:'a',name:'Cut',version:1,processing:'ready',review_state:'reviewing',thumbnail_url:'/cut.jpg',comments:[],review_progress:{stage:'reading',step:'analysing'}}
  const props={token:'t',onSelect:vi.fn(),onRefresh:vi.fn(),assets:[asset]}
  const {rerender}=render(<RequestWorkspace {...props} />)
  expect(screen.getByRole('progressbar')).toBeVisible()
  rerender(<RequestWorkspace {...props} statusUnavailable />)
  expect(screen.getByText('Review unavailable')).toBeVisible()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(document.querySelector('.review-analysis')).toHaveAttribute('data-scanning','false')
  expect(screen.getByAltText('Still frame of your submitted video')).toBeVisible()
  rerender(<RequestWorkspace {...props} statusUnavailable={false} />)
  expect(screen.getByRole('progressbar')).toBeVisible()
})

it('retains saved source labels in the actual editor workspace while preserving timestamp navigation', () => {
  const asset: RequestAsset = { asset_id: 'a', name: 'October launch', version: 1, version_id: 'v1', processing: 'ready', review_state: 'held', media_url: '/cut.mp4', comments: [
    { id: 'c1', t: 2, body: 'Hold the end card.', must_fix: true, review_source: {
      schema_version: 'autoreview.comment-source.v1', requirement_id: 'req-1',
      sources: [{ layer: 'briefing', reference_id: 'request-1', source_version: 'v1' }],
    } },
    { id: 'c2', t: 3, body: 'Give the logo room to breathe.' },
  ] }
  render(<RequestWorkspace token="t" assets={[asset]} onSelect={vi.fn()} onRefresh={vi.fn()} />)
  expect(screen.getByLabelText('Requirement sources')).toHaveTextContent('Briefing')
  expect(screen.getAllByLabelText('Requirement sources')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '0:02' })).toBeVisible()
  expect(screen.getByText('Hold the end card.')).toBeVisible()
})

it('restores server elapsed across remount and resets only on a new version', () => {
 const props={token:'clock',onSelect:vi.fn(),onRefresh:vi.fn()}
 const asset:RequestAsset={asset_id:'a',name:'Four minute ad',version:1,version_id:'v1',processing:'ready',review_state:'reviewing',comments:[],review_progress:{stage:'reading',step:'analysing',elapsedSeconds:241}}
 const view=render(<RequestWorkspace {...props} assets={[asset]} />)
 expect(screen.getByText('4:01 elapsed')).toBeVisible(); view.unmount()
 const next=render(<RequestWorkspace {...props} assets={[asset]} />)
 expect(screen.getByText('4:01 elapsed')).toBeVisible()
 next.rerender(<RequestWorkspace {...props} assets={[{...asset,version:2,version_id:'v2',review_progress:{stage:'waiting',elapsedSeconds:4}}]} />)
 expect(screen.getByText('0:04 elapsed')).toBeVisible()
 expect(screen.getByText('Waiting for review')).toBeVisible()
})
it('stops motion when offline or failed while retaining the source frame',()=>{
 const asset:RequestAsset={asset_id:'a',name:'Ad',version:1,version_id:'v1',processing:'ready',review_state:'reviewing',thumbnail_url:'/cut.jpg',comments:[],review_progress:{stage:'reading',step:'analysing',elapsedSeconds:60}}
 const props={token:'offline',onSelect:vi.fn(),onRefresh:vi.fn()}
 const view=render(<RequestWorkspace {...props} assets={[asset]} />)
 vi.spyOn(window.navigator,'onLine','get').mockReturnValue(false)
 act(()=>window.dispatchEvent(new Event('offline')))
 expect(screen.getByText('Connection paused')).toBeVisible()
 expect(screen.queryByRole('progressbar')).toBeNull()
 expect(screen.getByAltText('Still frame of your submitted video')).toBeVisible()
 vi.restoreAllMocks(); act(()=>window.dispatchEvent(new Event('online')))
 view.rerender(<RequestWorkspace {...props} assets={[{...asset,review_progress:{stage:'failed'}}]} />)
 expect(screen.getByText('Review unavailable')).toBeVisible()
 expect(screen.queryByRole('progressbar')).toBeNull()
})

it('shows a dead version as not uploaded even with nothing to offer, never as a review', () => {
  const dead = { id: 'v1', version_number: 1, processing: 'uploading' }
  const asset: RequestAsset = { asset_id: 'a', name: 'Cut', version: 1, version_id: 'v1', processing: 'uploading', review_state: 'upload_incomplete', comments: [], versions: [dead] }
  render(<RequestWorkspace token="t" assets={[asset]} onSelect={vi.fn()} onRefresh={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Upload not finished' })).toBeVisible()
  expect(screen.queryByText('Review in progress')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Upload it again' })).toBeNull()
})

it('opens on the file that needs the editor when several are listed', () => {
  const ok: RequestAsset = { asset_id: 'ok', name: 'Fine', version: 1, version_id: 'v1', processing: 'processing', review_state: 'reviewing', comments: [] }
  const dead: RequestAsset = { asset_id: 'dead', name: 'Hook 2', version: 1, version_id: 'v2', processing: 'uploading', review_state: 'upload_incomplete', comments: [] }
  render(<RequestWorkspace token="t" assets={[ok, dead]} onSelect={vi.fn()} onRefresh={vi.fn()} onRevise={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Upload not finished' })).toBeVisible()
  expect(screen.getByRole('option', { name: 'Hook 2 · Not uploaded' })).toBeInTheDocument()
})
