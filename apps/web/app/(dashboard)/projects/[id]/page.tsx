'use client'

import * as React from 'react'
import { useParams } from 'next/navigation'
import useSWR from 'swr'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Upload, Users, ChevronRight, X, FolderOpen,
  Link as LinkIcon, Download, Filter, Share2, Plus,
  Trash2, ChevronDown, MessageSquare, Info, Settings,
} from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import { Badge } from '@/components/shared/badge'
import { AssetGrid } from '@/components/projects/asset-grid'
import { UploadZone } from '@/components/upload/upload-zone'
import { UploadProgress } from '@/components/upload/upload-progress'
import { useUpload } from '@/hooks/use-upload'
import type { Project, AssetResponse, ProjectMember, User, Collection } from '@/types'

// ─── Collection icon colors (Frame.io style) ──────────────────────────────────
const collectionIcons: Record<string, { icon: string; color: string }> = {
  'needs review': { icon: '👀', color: 'text-yellow-400' },
  'audio': { icon: '🎵', color: 'text-blue-400' },
  'images': { icon: '🖼️', color: 'text-pink-400' },
  'videos': { icon: '🎬', color: 'text-purple-400' },
  'approved': { icon: '🎉', color: 'text-green-400' },
}

function getCollectionIcon(name: string) {
  const lower = name.toLowerCase()
  for (const [key, val] of Object.entries(collectionIcons)) {
    if (lower.includes(key)) return val
  }
  return { icon: '📁', color: 'text-text-tertiary' }
}

export default function ProjectDetailPage() {
  const params = useParams()
  const projectId = params.id as string

  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [assetName, setAssetName] = React.useState('')
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([])
  const [selectedAsset, setSelectedAsset] = React.useState<AssetResponse | null>(null)
  const [collectionsExpanded, setCollectionsExpanded] = React.useState(true)
  const [shareLinksExpanded, setShareLinksExpanded] = React.useState(true)
  const [rightTab, setRightTab] = React.useState<'comments' | 'fields'>('comments')

  const { files: uploadFiles, startUpload, cancelUpload, removeFile, clearCompleted } = useUpload()

  const { data: project, isLoading: loadingProject } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  )

  const { data: assets, isLoading: loadingAssets, mutate: mutateAssets } = useSWR<AssetResponse[]>(
    `/projects/${projectId}/assets`,
    () => api.get<AssetResponse[]>(`/projects/${projectId}/assets`),
  )

  const { data: collections } = useSWR<Collection[]>(
    `/projects/${projectId}/collections`,
    () => api.get<Collection[]>(`/projects/${projectId}/collections`),
  )

  const thumbnails = React.useMemo(() => {
    if (!assets) return {}
    const map: Record<string, string> = {}
    for (const a of assets) {
      if (a.thumbnail_url) map[a.id] = a.thumbnail_url
    }
    return map
  }, [assets])

  const versionCounts = React.useMemo(() => {
    if (!assets) return {}
    const map: Record<string, number> = {}
    for (const a of assets) {
      if (a.latest_version) map[a.id] = a.latest_version.version_number
    }
    return map
  }, [assets])

  const { data: members } = useSWR<ProjectMember[]>(
    `/projects/${projectId}/members`,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )

  const assigneeIds = React.useMemo(() => {
    if (!assets) return []
    const ids = assets.map((a) => a.assignee_id).filter(Boolean) as string[]
    return Array.from(new Set(ids))
  }, [assets])

  const { data: assigneeUsers } = useSWR<User[]>(
    assigneeIds.length > 0 ? `/users?ids=${assigneeIds.join(',')}` : null,
    () => api.get<User[]>(`/users?ids=${assigneeIds.join(',')}`),
  )

  const assigneesMap: Record<string, User> = React.useMemo(() => {
    if (!assigneeUsers) return {}
    return Object.fromEntries(assigneeUsers.map((u) => [u.id, u]))
  }, [assigneeUsers])

  React.useEffect(() => {
    const anyComplete = uploadFiles.some((f) => f.status === 'complete')
    if (anyComplete) mutateAssets()
  }, [uploadFiles, mutateAssets])

  const handleFilesSelected = (files: File[]) => {
    setPendingFiles(files)
    if (files.length > 0) setAssetName(files[0].name.replace(/\.[^/.]+$/, ''))
  }

  const handleStartUpload = () => {
    pendingFiles.forEach((file) => {
      const name = pendingFiles.length === 1 ? assetName || file.name : file.name
      startUpload(file, projectId, name)
    })
    setPendingFiles([])
    setAssetName('')
    setUploadOpen(false)
  }

  return (
    <div className="flex h-full flex-col lg:flex-row overflow-hidden">
      {/* ─── Left Sidebar (Frame.io style) ──────────────────────────────── */}
      <div className="hidden lg:flex w-72 flex-col border-r border-border bg-bg-secondary shrink-0">
        {/* Assets section */}
        <div className="p-3 space-y-0.5">
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">Assets</span>
            <button className="text-text-tertiary hover:text-text-primary transition-colors">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Project folder tree */}
          <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-accent/10 text-sm text-accent font-medium">
            <FolderOpen className="h-4 w-4" />
            <span className="truncate">{project?.name || 'Project'}</span>
          </button>

          {/* Placeholder subfolder */}
          <div className="ml-4 space-y-0.5">
            <button className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors">
              <Trash2 className="h-3.5 w-3.5" />
              Recently Deleted
            </button>
          </div>
        </div>

        {/* Collections section */}
        <div className="px-3 py-2 border-t border-border">
          <button
            onClick={() => setCollectionsExpanded(!collectionsExpanded)}
            className="w-full flex items-center justify-between px-2 mb-1"
          >
            <span className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">Collections</span>
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation() }}
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <ChevronDown className={cn('h-3 w-3 text-text-tertiary transition-transform', !collectionsExpanded && '-rotate-90')} />
            </div>
          </button>

          {collectionsExpanded && (
            <div className="space-y-0.5">
              {collections && collections.length > 0 ? (
                collections.map((c) => {
                  const { icon } = getCollectionIcon(c.name)
                  return (
                    <Link
                      key={c.id}
                      href={`/projects/${projectId}/collections?id=${c.id}`}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                    >
                      <span className="text-sm">{icon}</span>
                      <span className="truncate">{c.name}</span>
                    </Link>
                  )
                })
              ) : null}
              <Link
                href={`/projects/${projectId}/collections`}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
              >
                <Plus className="h-4 w-4" />
                <span>New Collection</span>
              </Link>
            </div>
          )}
        </div>

        {/* Share Links section */}
        <div className="px-3 py-2 border-t border-border">
          <button
            onClick={() => setShareLinksExpanded(!shareLinksExpanded)}
            className="w-full flex items-center justify-between px-2 mb-1"
          >
            <span className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">Share Links</span>
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation() }}
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <ChevronDown className={cn('h-3 w-3 text-text-tertiary transition-transform', !shareLinksExpanded && '-rotate-90')} />
            </div>
          </button>

          {shareLinksExpanded && (
            <div className="px-2 py-2 text-xs text-text-tertiary">
              No share links yet
            </div>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Storage */}
        <div className="p-3 border-t border-border">
          <div className="flex items-center justify-between text-2xs text-text-tertiary mb-1.5">
            <span>Storage</span>
            <span>{assets ? formatBytes(assets.length * 1024 * 1024 * 5) : '0 B'}</span>
          </div>
          <div className="h-1 w-full bg-bg-tertiary rounded-full overflow-hidden">
            <div className="h-full bg-accent w-1/12" />
          </div>
        </div>
      </div>

      {/* ─── Main Content ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg-primary h-full overflow-y-auto">
        <div className="px-6 pt-4 pb-6 space-y-4">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-xs text-text-tertiary">
            <Link href="/projects" className="hover:text-text-primary transition-colors">Projects</Link>
            <ChevronRight className="h-3 w-3" />
            <span className="text-text-secondary">{loadingProject ? '...' : project?.name}</span>
          </nav>

          {/* Header row: project name + members + actions */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-text-primary">
                {loadingProject ? '...' : project?.name}
              </h1>
              {/* Member avatars */}
              {members && members.length > 0 && (
                <button className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 hover:bg-bg-hover transition-colors">
                  <Users className="h-3 w-3 text-text-tertiary" />
                  <span className="text-2xs text-text-secondary">{members.length}</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm">
                <Share2 className="h-4 w-4" />
                Share
              </Button>

              <Dialog.Root open={uploadOpen} onOpenChange={setUploadOpen}>
                <Dialog.Trigger asChild>
                  <Button size="sm">
                    <Upload className="h-4 w-4" />
                    Upload
                  </Button>
                </Dialog.Trigger>

                <Dialog.Portal>
                  <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
                  <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                    <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
                      <X className="h-4 w-4" />
                    </Dialog.Close>
                    <Dialog.Title className="text-base font-semibold text-text-primary">Upload asset</Dialog.Title>
                    <Dialog.Description className="mt-1 text-sm text-text-secondary">Add new media to this project.</Dialog.Description>
                    <div className="mt-4 space-y-4">
                      {pendingFiles.length === 0 ? (
                        <UploadZone onFilesSelected={handleFilesSelected} />
                      ) : (
                        <>
                          <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">
                            {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} selected:{' '}
                            {pendingFiles.map((f) => f.name).join(', ')}
                          </div>
                          {pendingFiles.length === 1 && (
                            <Input label="Asset name" value={assetName} onChange={(e) => setAssetName(e.target.value)} placeholder="e.g. Hero Video Final" />
                          )}
                          <div className="flex justify-end gap-2">
                            <Button type="button" variant="secondary" size="sm" onClick={() => setPendingFiles([])}>Change files</Button>
                            <Button size="sm" onClick={handleStartUpload}>Start upload</Button>
                          </div>
                        </>
                      )}
                    </div>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
            </div>
          </div>

          {/* Active uploads */}
          {uploadFiles.length > 0 && (
            <UploadProgress uploads={uploadFiles} onCancel={cancelUpload} onRemove={removeFile} onClearCompleted={clearCompleted} />
          )}

          {/* Asset grid */}
          <AssetGrid
            assets={assets ?? []}
            projectId={projectId}
            isLoading={loadingAssets}
            assignees={assigneesMap}
            thumbnails={thumbnails}
            versionCounts={versionCounts}
            onUpload={() => setUploadOpen(true)}
            onAssetSelect={(asset) => setSelectedAsset(asset as AssetResponse)}
          />
        </div>
      </div>

      {/* ─── Right Panel (Comments + Fields tabs) ───────────────────────── */}
      {selectedAsset ? (
        <div className="hidden xl:flex w-[360px] flex-col border-l border-border bg-bg-secondary shrink-0 animate-in slide-in-from-right-4 duration-150">
          {/* Tabs */}
          <div className="flex items-center border-b border-border">
            <button
              onClick={() => setRightTab('comments')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors border-b-2',
                rightTab === 'comments'
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary',
              )}
            >
              <MessageSquare className="h-4 w-4" />
              Comments
            </button>
            <button
              onClick={() => setRightTab('fields')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors border-b-2',
                rightTab === 'fields'
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary',
              )}
            >
              Fields
            </button>
            <button
              onClick={() => setSelectedAsset(null)}
              className="px-3 text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {rightTab === 'comments' ? (
            /* Comments tab */
            <div className="flex-1 flex flex-col">
              <div className="flex-1 flex items-center justify-center p-6 text-center">
                <div>
                  <div className="mx-auto mb-3 h-16 w-16 rounded-full bg-bg-tertiary flex items-center justify-center">
                    <MessageSquare className="h-8 w-8 text-text-tertiary/50" />
                  </div>
                  <p className="text-sm text-text-secondary">No comments &ndash; yet</p>
                  <Link href={`/projects/${projectId}/assets/${selectedAsset.id}`}>
                    <Button size="sm" className="mt-3">Get Started</Button>
                  </Link>
                </div>
              </div>
              {/* Comment input bar */}
              <div className="border-t border-border p-3">
                <Link href={`/projects/${projectId}/assets/${selectedAsset.id}`}>
                  <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-tertiary cursor-pointer hover:border-border-focus transition-colors">
                    Leave your comment...
                  </div>
                </Link>
              </div>
            </div>
          ) : (
            /* Fields tab */
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Thumbnail preview */}
              <div className="aspect-video bg-bg-tertiary rounded-lg overflow-hidden border border-border flex items-center justify-center">
                {selectedAsset.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selectedAsset.thumbnail_url} alt={selectedAsset.name} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xs text-text-tertiary uppercase font-bold">{selectedAsset.asset_type}</span>
                )}
              </div>

              <h4 className="text-sm font-semibold text-text-primary break-words">{selectedAsset.name}</h4>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-tertiary">Type</span>
                  <span className="text-xs text-text-primary capitalize">{selectedAsset.asset_type.replace('_', ' ')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-tertiary">Status</span>
                  <Badge status={selectedAsset.status} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-tertiary">Uploaded</span>
                  <span className="text-xs text-text-primary">{formatRelativeTime(selectedAsset.created_at)}</span>
                </div>
                {selectedAsset.latest_version && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-tertiary">Version</span>
                    <span className="text-xs text-text-primary">v{selectedAsset.latest_version.version_number}</span>
                  </div>
                )}
                {selectedAsset.assignee_id && assigneesMap[selectedAsset.assignee_id] && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-tertiary">Assignee</span>
                    <div className="flex items-center gap-1.5">
                      <Avatar size="sm" className="h-5 w-5" />
                      <span className="text-xs text-text-primary">{assigneesMap[selectedAsset.assignee_id].name}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-border grid grid-cols-2 gap-2">
                <Link href={`/projects/${projectId}/assets/${selectedAsset.id}`} className="col-span-2">
                  <Button className="w-full" size="sm">Open in Player</Button>
                </Link>
                <Button variant="secondary" size="sm" className="gap-1">
                  <LinkIcon className="h-3.5 w-3.5" /> Share
                </Button>
                <Button variant="secondary" size="sm" className="gap-1">
                  <Download className="h-3.5 w-3.5" /> Download
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="hidden xl:flex w-[360px] flex-col border-l border-border bg-bg-secondary shrink-0">
          {/* Empty right panel with tabs still visible */}
          <div className="flex items-center border-b border-border">
            <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium border-b-2 border-accent text-text-primary">
              <MessageSquare className="h-4 w-4" />
              Comments
            </button>
            <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium border-b-2 border-transparent text-text-tertiary">
              Fields
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <div className="mx-auto mb-3 h-16 w-16 rounded-full bg-bg-tertiary flex items-center justify-center">
                <MessageSquare className="h-8 w-8 text-text-tertiary/50" />
              </div>
              <p className="text-sm text-text-secondary">Select an asset to view comments</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
