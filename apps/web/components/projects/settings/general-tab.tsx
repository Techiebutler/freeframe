'use client'

import * as React from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import { Eye, ImagePlus, Loader2, Moon, Palette, Settings2, Sun, Upload, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getGradientForProject } from '@/lib/gradient-utils'
import { AVATAR_INPUT_TYPES, AVATAR_MAX_INPUT_BYTES } from '@/lib/avatar-image'
import { CUSTOM_FOOTER_MAX, resolveShareLogoUrl, uploadProjectLogo } from '@/lib/project-branding'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segment, ToggleRow } from '@/components/ui/setting-controls'
import { Skeleton } from '@/components/shared/skeleton'
import { useBranding } from '@/components/shared/branding-provider'
import { HexColorField } from '@/components/projects/share-appearance-fields'
import { SharePagePreviewFrame } from '@/components/projects/share-page-preview'
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard'
import type { Project, ProjectBranding } from '@/types'

/** What POST /projects/{id}/poster accepts. */
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const COVER_MAX_BYTES = 10 * 1024 * 1024

/** A picture the page has not saved yet: unchanged, replaced, or removed. */
type ImageChange =
  | { kind: 'keep' }
  | { kind: 'set'; file: File; previewUrl: string }
  | { kind: 'remove' }

const KEEP: ImageChange = { kind: 'keep' }

interface DetailsValues {
  name: string
  description: string
  isPublic: boolean
}

interface BrandingValues {
  useCoverAsLogo: boolean
  primaryColor: string | null
  customFooter: string
}

function detailsFrom(project: Pick<Project, 'name' | 'description' | 'is_public'>): DetailsValues {
  return {
    name: project.name,
    description: project.description ?? '',
    isPublic: project.is_public ?? false,
  }
}

function brandingFrom(branding: ProjectBranding): BrandingValues {
  return {
    useCoverAsLogo: branding.use_cover_as_logo ?? false,
    primaryColor: branding.primary_color ?? null,
    customFooter: branding.custom_footer ?? '',
  }
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong'
}

/** The URL a picture shows with its unsaved change applied. */
function imageUrl(saved: string | null | undefined, change: ImageChange): string | null {
  if (change.kind === 'set') return change.previewUrl
  if (change.kind === 'remove') return null
  return saved ?? null
}

/** Revokes a picked picture's object URL once it is replaced or the page goes. */
function useRevokeOnChange(change: ImageChange) {
  const url = change.kind === 'set' ? change.previewUrl : null
  React.useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])
}

type SaveStatus = { kind: 'saved' } | { kind: 'failed'; failures: string[] } | null

/**
 * The General tab of project settings: the project's own details, its share
 * page branding, and a preview of that branding, all saved by one Save.
 *
 * The page keeps this tab mounted while another is open, so an unsaved draft
 * survives a look at People. A refetch of the project does not reset the
 * draft either: the saved values are taken once, then only from this tab's own
 * save responses.
 *
 * Save writes each part to its own endpoint and keeps going when one fails:
 * the cover, then the details, then the logo upload, then the branding. A part
 * that fails stays in the draft, and the bar names it, so Save again retries
 * just what is left.
 */
export function ProjectGeneralTab({ project }: { project: Project }) {
  const projectId = project.id
  const brandingKey = `/projects/${projectId}/branding`
  const {
    data: branding,
    error: brandingError,
    mutate: mutateBranding,
  } = useSWR<ProjectBranding>(brandingKey, () => api.get<ProjectBranding>(brandingKey))
  const { primaryColor: instanceAccent } = useBranding()

  // Saved values: the baseline the draft is compared against.
  const [savedDetails, setSavedDetails] = React.useState<DetailsValues>(() => detailsFrom(project))
  const [savedCoverUrl, setSavedCoverUrl] = React.useState<string | null>(project.poster_url ?? null)
  const [savedBranding, setSavedBranding] = React.useState<BrandingValues | null>(null)
  const [savedLogoUrl, setSavedLogoUrl] = React.useState<string | null>(null)

  // The draft.
  const [details, setDetails] = React.useState<DetailsValues>(savedDetails)
  const [cover, setCover] = React.useState<ImageChange>(KEEP)
  const [brandingDraft, setBrandingDraft] = React.useState<BrandingValues | null>(null)
  const [logo, setLogo] = React.useState<ImageChange>(KEEP)
  useRevokeOnChange(cover)
  useRevokeOnChange(logo)

  const [coverError, setCoverError] = React.useState<string | null>(null)
  const [logoError, setLogoError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [status, setStatus] = React.useState<SaveStatus>(null)
  const [previewTheme, setPreviewTheme] = React.useState<'dark' | 'light'>('dark')
  // A logo uploaded by a save whose branding write then failed: the next save
  // reuses its key rather than uploading the same file again.
  const uploadedLogo = React.useRef<{ file: File; key: string } | null>(null)

  // Branding arrives after the project. Taken once; later revalidations of the
  // same key do not overwrite a draft.
  const brandingTaken = React.useRef(false)
  React.useEffect(() => {
    if (!branding || brandingTaken.current) return
    brandingTaken.current = true
    const values = brandingFrom(branding)
    setSavedBranding(values)
    setBrandingDraft(values)
    setSavedLogoUrl(branding.logo_url ?? null)
  }, [branding])

  const detailsDirty =
    details.name !== savedDetails.name ||
    details.description !== savedDetails.description ||
    details.isPublic !== savedDetails.isPublic
  const brandingDirty =
    !!brandingDraft &&
    !!savedBranding &&
    (brandingDraft.useCoverAsLogo !== savedBranding.useCoverAsLogo ||
      brandingDraft.primaryColor !== savedBranding.primaryColor ||
      brandingDraft.customFooter !== savedBranding.customFooter)
  const dirty = detailsDirty || brandingDirty || cover.kind !== 'keep' || logo.kind !== 'keep'
  const nameMissing = !details.name.trim()

  const leaveDialog = useUnsavedChangesGuard(dirty)

  function pickCover(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!COVER_TYPES.includes(file.type)) {
      setCoverError('Choose a JPG, PNG, WEBP or GIF image')
      return
    }
    if (file.size > COVER_MAX_BYTES) {
      setCoverError('Image must be under 10 MB')
      return
    }
    setCoverError(null)
    setCover({ kind: 'set', file, previewUrl: URL.createObjectURL(file) })
  }

  function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) {
      setLogoError('Choose a PNG, JPG or WEBP image')
      return
    }
    if (file.size > AVATAR_MAX_INPUT_BYTES) {
      setLogoError('Image must be under 10 MB')
      return
    }
    setLogoError(null)
    setLogo({ kind: 'set', file, previewUrl: URL.createObjectURL(file) })
  }

  function discard() {
    setDetails(savedDetails)
    setCover(KEEP)
    setLogo(KEEP)
    setBrandingDraft(savedBranding)
    setCoverError(null)
    setLogoError(null)
    setStatus(null)
  }

  async function save() {
    if (saving || nameMissing) return
    setSaving(true)
    setStatus(null)
    const failures: string[] = []
    // Snapshots: an edit made while the save is running stays unsaved.
    const sentDetails = details
    const sentCover = cover
    const sentBranding = brandingDraft
    const sentLogo = logo

    if (sentCover.kind === 'set') {
      try {
        const form = new FormData()
        form.append('file', sentCover.file)
        const updated = await api.upload<Project>(`/projects/${projectId}/poster`, form)
        setSavedCoverUrl(updated.poster_url ?? null)
        setCover((c) => (c === sentCover ? KEEP : c))
      } catch (err) {
        failures.push(`Cover image: ${errorText(err)}`)
      }
    } else if (sentCover.kind === 'remove') {
      try {
        await api.delete(`/projects/${projectId}/poster`)
        setSavedCoverUrl(null)
        setCover((c) => (c === sentCover ? KEEP : c))
      } catch (err) {
        failures.push(`Cover image: ${errorText(err)}`)
      }
    }

    const patch: Record<string, unknown> = {}
    if (sentDetails.name !== savedDetails.name) patch.name = sentDetails.name.trim()
    if (sentDetails.description !== savedDetails.description) {
      // An empty description clears it.
      patch.description = sentDetails.description.trim() || null
    }
    if (sentDetails.isPublic !== savedDetails.isPublic) patch.is_public = sentDetails.isPublic
    if (Object.keys(patch).length > 0) {
      try {
        await api.patch<Project>(`/projects/${projectId}`, patch)
        setSavedDetails(sentDetails)
      } catch (err) {
        failures.push(`Project details: ${errorText(err)}`)
      }
    }

    if (sentBranding && savedBranding) {
      const body: Record<string, unknown> = {}
      if (sentLogo.kind === 'set') {
        try {
          const reused = uploadedLogo.current?.file === sentLogo.file ? uploadedLogo.current.key : null
          const key = reused ?? (await uploadProjectLogo(projectId, sentLogo.file))
          uploadedLogo.current = { file: sentLogo.file, key }
          body.logo_s3_key = key
        } catch (err) {
          // The picked logo stays in the draft; the other fields still save.
          failures.push(`Logo: ${errorText(err)}`)
        }
      } else if (sentLogo.kind === 'remove') {
        body.logo_s3_key = null
      }
      // Only what changed: the API leaves a field it is not sent alone, and an
      // explicit null clears one.
      if (sentBranding.useCoverAsLogo !== savedBranding.useCoverAsLogo) {
        body.use_cover_as_logo = sentBranding.useCoverAsLogo
      }
      if (sentBranding.primaryColor !== savedBranding.primaryColor) {
        body.primary_color = sentBranding.primaryColor
      }
      if (sentBranding.customFooter !== savedBranding.customFooter) {
        body.custom_footer = sentBranding.customFooter.trim() || null
      }
      if (Object.keys(body).length > 0) {
        try {
          const updated = await api.put<ProjectBranding>(brandingKey, body)
          setSavedBranding({
            useCoverAsLogo: sentBranding.useCoverAsLogo,
            primaryColor: sentBranding.primaryColor,
            customFooter: sentBranding.customFooter,
          })
          setSavedLogoUrl(updated.logo_url ?? null)
          if ('logo_s3_key' in body) {
            uploadedLogo.current = null
            setLogo((l) => (l === sentLogo ? KEEP : l))
          }
          void mutateBranding(updated, { revalidate: false })
        } catch (err) {
          failures.push(`Branding: ${errorText(err)}`)
        }
      }
    }

    // Everything else showing this project picks up the new name and cover.
    void globalMutate(`/projects/${projectId}`)
    void globalMutate('/projects')
    setStatus(failures.length ? { kind: 'failed', failures } : { kind: 'saved' })
    setSaving(false)
  }

  const coverUrl = imageUrl(savedCoverUrl, cover)
  const logoUrl = imageUrl(savedLogoUrl, logo)
  const previewAccent = brandingDraft?.primaryColor ?? instanceAccent
  const previewLogo = resolveShareLogoUrl({
    useCoverAsLogo: brandingDraft?.useCoverAsLogo ?? false,
    coverUrl,
    logoUrl,
  })
  const footerText = brandingDraft?.customFooter.trim() || null

  return (
    <form
      className="space-y-6 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <ProjectCard
          projectId={projectId}
          details={details}
          onDetailsChange={(patch) => setDetails((d) => ({ ...d, ...patch }))}
          nameMissing={nameMissing}
          coverUrl={coverUrl}
          onPickCover={pickCover}
          onRemoveCover={() => setCover(savedCoverUrl ? { kind: 'remove' } : KEEP)}
          coverError={coverError}
        />

        <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-5">
          <CardHeading icon={Palette} title="Share page branding" />
          {brandingError && !brandingDraft ? (
            <div role="alert" className="rounded-lg border border-border bg-bg-tertiary/50 p-4 space-y-3">
              <p className="text-sm text-text-secondary">
                Branding could not be loaded: {errorText(brandingError)}
              </p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void mutateBranding()}>
                Retry
              </Button>
            </div>
          ) : !brandingDraft ? (
            <div className="space-y-3" aria-label="Loading branding">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <BrandingFields
              draft={brandingDraft}
              onChange={(patch) => setBrandingDraft((b) => (b ? { ...b, ...patch } : b))}
              hasCover={!!coverUrl}
              logoUrl={logoUrl}
              onPickLogo={pickLogo}
              onRemoveLogo={() => setLogo(savedLogoUrl ? { kind: 'remove' } : KEEP)}
              logoError={logoError}
            />
          )}
        </section>
      </div>

      <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardHeading
            icon={Eye}
            title="Share page preview"
            subtitle="A folder or project link, as a signed-out guest sees it"
          />
          <Segment<'dark' | 'light'>
            label="Preview theme"
            options={[
              { value: 'dark', icon: <Moon className="h-3.5 w-3.5" />, ariaLabel: 'Dark' },
              { value: 'light', icon: <Sun className="h-3.5 w-3.5" />, ariaLabel: 'Light' },
            ]}
            value={previewTheme}
            onChange={setPreviewTheme}
          />
        </div>
        <SharePagePreviewFrame
          theme={previewTheme}
          accent={previewAccent}
          projectLogoUrl={previewLogo}
          title={details.name.trim() || 'Untitled project'}
          allowDownload
          footer={footerText}
        >
          <PlaceholderGrid />
        </SharePagePreviewFrame>
        <p className="text-xs text-text-tertiary">
          The assets are placeholders, and a link&apos;s title replaces the project name. A
          link with its own accent colour keeps it, and a link&apos;s theme picks dark or light.
          A single-asset link opens straight into the review screen, which shows the logo and
          colour but has no footer.
        </p>
      </section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        canSave={dirty && !nameMissing}
        status={status}
        onDiscard={discard}
      />
      {leaveDialog}
    </form>
  )
}

function CardHeading({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  subtitle?: string
}) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-muted">
        <Icon className="h-4 w-4 text-accent" />
      </div>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {subtitle && <p className="text-xs text-text-tertiary">{subtitle}</p>}
      </div>
    </div>
  )
}

function ProjectCard({
  projectId,
  details,
  onDetailsChange,
  nameMissing,
  coverUrl,
  onPickCover,
  onRemoveCover,
  coverError,
}: {
  projectId: string
  details: DetailsValues
  onDetailsChange: (patch: Partial<DetailsValues>) => void
  nameMissing: boolean
  coverUrl: string | null
  onPickCover: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveCover: () => void
  coverError: string | null
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const descriptionId = React.useId()
  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-5">
      <CardHeading icon={Settings2} title="Project" />
      {/* The cover sits beside the fields from `sm` up and above them on a phone. */}
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="flex w-40 shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label={coverUrl ? 'Change cover image' : 'Add cover image'}
            className="group relative aspect-square w-full overflow-hidden rounded-xl border-2 border-dashed border-border hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
          >
            {coverUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={coverUrl} alt="Project cover" className="h-full w-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <ImagePlus className="h-6 w-6 text-white" />
                </span>
              </>
            ) : (
              <span
                className={cn(
                  'flex h-full w-full items-center justify-center bg-gradient-to-br',
                  getGradientForProject(projectId),
                )}
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/20 text-white/80">
                  <ImagePlus className="h-6 w-6" />
                </span>
              </span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={COVER_TYPES.join(',')}
            className="hidden"
            data-testid="cover-input"
            onChange={onPickCover}
          />
          {coverUrl && (
            <Button type="button" variant="ghost" size="sm" onClick={onRemoveCover}>
              <X className="h-3.5 w-3.5" />
              Remove cover
            </Button>
          )}
          {coverError && <p className="text-xs text-status-error">{coverError}</p>}
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <Input
            label="Name"
            value={details.name}
            onChange={(e) => onDetailsChange({ name: e.target.value })}
            error={nameMissing ? 'A project needs a name.' : undefined}
            aria-invalid={nameMissing}
            maxLength={255}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={descriptionId} className="text-sm font-medium text-text-secondary">
              Description
            </label>
            <textarea
              id={descriptionId}
              rows={3}
              value={details.description}
              onChange={(e) => onDetailsChange({ description: e.target.value })}
              placeholder="Optional"
              className="w-full resize-none rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <ToggleRow
            label="Private"
            description={
              details.isPublic
                ? 'All users in the system can view this project.'
                : 'Only invited members can access this project.'
            }
            checked={!details.isPublic}
            onCheckedChange={(isPrivate) => onDetailsChange({ isPublic: !isPrivate })}
          />
        </div>
      </div>
    </section>
  )
}

function BrandingFields({
  draft,
  onChange,
  hasCover,
  logoUrl,
  onPickLogo,
  onRemoveLogo,
  logoError,
}: {
  draft: BrandingValues
  onChange: (patch: Partial<BrandingValues>) => void
  hasCover: boolean
  logoUrl: string | null
  onPickLogo: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveLogo: () => void
  logoError: string | null
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const footerId = React.useId()
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <ToggleRow
          label="Use project cover as share logo"
          description="Share pages show the cover image in their header."
          checked={draft.useCoverAsLogo}
          onCheckedChange={(useCoverAsLogo) => onChange({ useCoverAsLogo })}
        />
        {draft.useCoverAsLogo && !hasCover && (
          <p className="text-xs text-text-tertiary">
            This project has no cover image, so share pages show{' '}
            {logoUrl ? 'its logo' : 'the instance logo'} until one is added.
          </p>
        )}
      </div>

      {!draft.useCoverAsLogo && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-text-secondary">Logo</p>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-tertiary">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="Share page logo" className="h-full w-full object-contain p-1" />
              ) : (
                <span className="text-2xs text-text-tertiary">Instance logo</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" />
                {logoUrl ? 'Replace' : 'Upload'}
              </Button>
              {logoUrl && (
                <Button type="button" variant="ghost" size="sm" onClick={onRemoveLogo}>
                  <X className="h-3.5 w-3.5" />
                  Remove
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={AVATAR_INPUT_TYPES.join(',')}
              className="hidden"
              data-testid="logo-input"
              onChange={onPickLogo}
            />
          </div>
          <p className="text-xs text-text-tertiary">
            PNG, JPG or WEBP. Without one, share pages show the instance logo.
          </p>
          {logoError && <p className="text-xs text-status-error">{logoError}</p>}
        </div>
      )}

      <div className="space-y-1">
        <HexColorField
          label="Primary colour"
          name="primary colour"
          value={draft.primaryColor}
          onChange={(primaryColor) => onChange({ primaryColor })}
        />
        <p className="text-xs text-text-tertiary">
          Buttons and highlights on share pages. Clear it to use the instance colour; a
          link&apos;s own accent colour still wins.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={footerId} className="text-sm font-medium text-text-secondary">
          Footer text
        </label>
        <textarea
          id={footerId}
          rows={2}
          maxLength={CUSTOM_FOOTER_MAX}
          value={draft.customFooter}
          onChange={(e) => onChange({ customFooter: e.target.value })}
          placeholder="Shown at the bottom of folder and project share pages"
          className="w-full resize-none rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <p className="text-right text-2xs tabular-nums text-text-tertiary">
          {draft.customFooter.length}/{CUSTOM_FOOTER_MAX}
        </p>
      </div>
    </div>
  )
}

/** Stand-in cards: the preview cannot know which assets a link will hold. */
function PlaceholderGrid() {
  return (
    <div className="space-y-3">
      <span className="text-xs font-medium uppercase tracking-wider text-text-tertiary">Assets</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'overflow-hidden rounded-lg border bg-bg-tertiary/50',
              // The share page rings the selected card in the accent.
              i === 0 ? 'border-accent/60 ring-1 ring-accent/40' : 'border-border',
            )}
          >
            <div className="aspect-[16/10] bg-bg-tertiary" />
            <div className="px-3 py-2">
              <div className="h-2.5 w-2/3 rounded bg-bg-hover" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SaveBar({
  dirty,
  saving,
  canSave,
  status,
  onDiscard,
}: {
  dirty: boolean
  saving: boolean
  canSave: boolean
  status: SaveStatus
  onDiscard: () => void
}) {
  return (
    <div
      role="region"
      aria-label="Save changes"
      className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-bg-primary/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-live="polite" className="min-w-0 flex-1 text-sm">
          {status?.kind === 'failed' ? (
            <div role="alert" className="text-status-error">
              <p className="font-medium">Some changes were not saved.</p>
              <ul className="mt-0.5 space-y-0.5 text-xs">
                {status.failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          ) : saving ? (
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </span>
          ) : dirty ? (
            <span className="text-text-secondary">Unsaved changes</span>
          ) : status?.kind === 'saved' ? (
            <span className="text-text-secondary">Saved.</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && (
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
          )}
          <Button type="submit" size="sm" loading={saving} disabled={!canSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
