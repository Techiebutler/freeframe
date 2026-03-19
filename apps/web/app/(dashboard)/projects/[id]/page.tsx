'use client'

import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import useSWR from 'swr'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { Settings, Upload, Users, ChevronRight, X, FolderOpen, MoreHorizontal, Link as LinkIcon, Download, Info } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import { AssetGrid } from '@/components/projects/asset-grid'
import { UploadZone } from '@/components/upload/upload-zone'
import { UploadProgress } from '@/components/upload/upload-progress'
import { useUpload } from '@/hooks/use-upload'
import type { Project, Asset, ProjectMember, User } from '@/types'

export default function ProjectDetailPage() {
  const params = useParams()
  const projectId = params.id as string

  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [assetName, setAssetName] = React.useState('')
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([])

  const { files: uploadFiles, startUpload, cancelUpload, removeFile, clearCompleted } = useUpload()

  const [selectedAsset, setSelectedAsset] = React.useState<Asset | null>(null)

  const { data: project, isLoading: loadingProject } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  )

  const { data: assets, isLoading: loadingAssets, mutate: mutateAssets } = useSWR<Asset[]>(
    `/projects/${projectId}/assets`,
    () => api.get<Asset[]>(`/projects/${projectId}/assets`),
  )

  const { data: members } = useSWR<ProjectMember[]>(
    `/projects/${projectId}/members`,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )

  // Fetch assignee users for assets that have one
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

  // When upload completes, refresh assets
  React.useEffect(() => {
    const anyComplete = uploadFiles.some((f) => f.status === 'complete')
    if (anyComplete) {
      mutateAssets()
    }
  }, [uploadFiles, mutateAssets])

  const handleFilesSelected = (files: File[]) => {
    setPendingFiles(files)
    // Default asset name to first file name (without extension)
    if (files.length > 0) {
      setAssetName(files[0].name.replace(/\.[^/.]+$/, ''))
    }
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

  const displayMembers = members?.slice(0, 5) ?? []
  const extraMemberCount = (members?.length ?? 0) - displayMembers.length

  return (
    <div className="flex h-full flex-col lg:flex-row overflow-hidden">
      {/* Sidebar - Project Tree */}
      <div className="hidden lg:flex w-64 flex-col border-r border-border bg-bg-secondary shrink-0">
        <div className="p-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-violet-600 to-fuchsia-500">
              <FolderOpen className="h-3.5 w-3.5 text-white" />
            </div>
            {project?.name || 'Project'}
          </h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-3">
          <div className="space-y-1">
            <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-hover text-sm text-text-primary font-medium">
              <FolderOpen className="h-4 w-4 text-accent" />
              All Assets
            </button>
            {/* Future: folder tree would go here */}
          </div>
        </div>

        <div className="p-4 border-t border-border">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-2">
            <span>Project Storage</span>
            <span>{assets ? formatBytes(assets.length * 1024 * 1024 * 5) : '0 B'}</span> {/* Mocking size for now since it's not on Asset */}
          </div>
          <div className="h-1.5 w-full bg-bg-tertiary rounded-full overflow-hidden">
            <div className="h-full bg-accent w-1/12"></div>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg-primary h-full overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* Breadcrumb */}
          <nav className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
              <Link href="/projects" className="hover:text-text-primary transition-colors">
                Projects
              </Link>
              <ChevronRight className="h-3 w-3" />
              <span className="text-text-secondary">
                {loadingProject ? '...' : project?.name}
              </span>
            </div>
          </nav>

          {/* Project header */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              {loadingProject ? (
                <>
                  <div className="h-6 w-48 animate-pulse rounded bg-bg-tertiary" />
                  <div className="h-4 w-72 animate-pulse rounded bg-bg-tertiary" />
                </>
              ) : (
                <>
                  <h1 className="text-xl font-semibold text-text-primary">
                    {project?.name}
                  </h1>
                  {project?.description && (
                    <p className="text-sm text-text-secondary">{project.description}</p>
                  )}
                </>
              )}

              {/* Member avatars */}
              {displayMembers.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5">
                  <div className="flex -space-x-2">
                    {displayMembers.map((m) => (
                      <Avatar key={m.id} size="sm" className="ring-2 ring-bg-primary" />
                    ))}
                  </div>
                  {extraMemberCount > 0 && (
                    <span className="text-xs text-text-tertiary">
                      +{extraMemberCount} more
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-xs text-text-tertiary ml-1">
                    <Users className="h-3 w-3" />
                    {members?.length} member{members?.length !== 1 ? 's' : ''}
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Link href={`/projects/${projectId}/settings`}>
                <Button variant="ghost" size="sm">
                  <Settings className="h-4 w-4" />
                  Settings
                </Button>
              </Link>

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

                    <Dialog.Title className="text-base font-semibold text-text-primary">
                      Upload asset
                    </Dialog.Title>
                    <Dialog.Description className="mt-1 text-sm text-text-secondary">
                      Add new media to this project.
                    </Dialog.Description>

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
                            <Input
                              label="Asset name"
                              value={assetName}
                              onChange={(e) => setAssetName(e.target.value)}
                              placeholder="e.g. Hero Video Final"
                            />
                          )}

                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setPendingFiles([])}
                            >
                              Change files
                            </Button>
                            <Button size="sm" onClick={handleStartUpload}>
                              Start upload
                            </Button>
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
            <UploadProgress
              uploads={uploadFiles}
              onCancel={cancelUpload}
              onRemove={removeFile}
              onClearCompleted={clearCompleted}
            />
          )}

          {/* Asset grid */}
          <AssetGrid
            assets={assets ?? []}
            projectId={projectId}
            isLoading={loadingAssets}
            assignees={assigneesMap}
            onUpload={() => setUploadOpen(true)}
            onAssetSelect={(asset) => setSelectedAsset(asset)}
          />
        </div>
      </div>

      {/* Right Details Panel */}
      {selectedAsset ? (
        <div className="hidden xl:flex w-80 flex-col border-l border-border bg-bg-secondary shrink-0 animate-in slide-in-from-right-8 duration-200">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-primary">Asset Details</h3>
            <button 
              onClick={() => setSelectedAsset(null)}
              className="text-text-tertiary hover:text-text-primary transition-colors p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {/* Preview thumbnail */}
            <div className="aspect-video bg-bg-tertiary rounded-lg overflow-hidden border border-border flex items-center justify-center">
              {/* This would be an actual thumbnail in the future */}
              <div className="text-text-tertiary">
                <span className="uppercase text-xs font-bold">{selectedAsset.asset_type}</span>
              </div>
            </div>

            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-text-primary break-words">
                {selectedAsset.name}
              </h4>
              <p className="text-xs text-text-tertiary">
                5 MB {/* Mocking size for now */}
              </p>
            </div>

            <div className="space-y-3 pt-4 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Type</span>
                <span className="text-xs text-text-primary capitalize">{selectedAsset.asset_type}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Status</span>
                <span className="inline-flex items-center rounded-full bg-status-warning/10 px-2 py-0.5 text-2xs font-medium text-status-warning">
                  Needs Review
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Uploaded</span>
                <span className="text-xs text-text-primary">{formatRelativeTime(selectedAsset.created_at)}</span>
              </div>
              {selectedAsset.assignee_id && assigneesMap[selectedAsset.assignee_id] && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Assignee</span>
                  <div className="flex items-center gap-1.5">
                    <Avatar size="sm" className="h-5 w-5" />
                    <span className="text-xs text-text-primary">{assigneesMap[selectedAsset.assignee_id].name}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-border grid grid-cols-2 gap-2">
              <Link href={`/projects/${projectId}/assets/${selectedAsset.id}`} className="col-span-2">
                <Button className="w-full" size="sm">Open in Player</Button>
              </Link>
              <Button variant="secondary" size="sm" className="flex items-center gap-1">
                <LinkIcon className="h-3.5 w-3.5" /> Share
              </Button>
              <Button variant="secondary" size="sm" className="flex items-center gap-1">
                <Download className="h-3.5 w-3.5" /> Download
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="hidden xl:flex w-80 flex-col border-l border-border bg-bg-secondary shrink-0 items-center justify-center p-6 text-center">
          <div className="h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center text-text-tertiary mb-3">
            <Info className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-medium text-text-primary mb-1">No asset selected</h3>
          <p className="text-xs text-text-tertiary">
            Select an asset from the grid to view its details, metadata, and quick actions.
          </p>
        </div>
      )}
    </div>
  )
}
