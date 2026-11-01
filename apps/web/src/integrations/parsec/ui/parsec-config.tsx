'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowPathIcon, FolderIcon } from '@heroicons/react/24/solid'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useUpdateIntegration } from '@/lib/client/mutations'
import { fetchExternalStatusesFn } from '@/lib/server/functions/external-statuses'
import type { ExternalStatus } from '@/components/admin/settings/integrations/status-sync-config'
import { StatusSyncConfig } from '@/components/admin/settings/integrations/status-sync-config'
import { TicketStatusSyncConfig } from '@/components/admin/settings/integrations/ticket-status-sync-config'
import {
  fetchParsecIssueOptionsFn,
  fetchParsecProjectsFn,
  type ParsecIssueOptions,
  type ParsecProjectOption,
} from '@/integrations/parsec/server/functions'

interface ParsecConfigProps {
  integrationId: string
  initialConfig: Record<string, unknown>
  enabled: boolean
}

const UNSET = '__unset__'

const PRIORITIES = [
  { id: 'urgent', name: 'Urgent' },
  { id: 'high', name: 'High' },
  { id: 'medium', name: 'Medium' },
  { id: 'low', name: 'Low' },
]

interface IssueDefaultProps {
  id: string
  label: string
  hint: string
  unsetLabel: string
  value: string
  options: { id: string; name: string }[]
  disabled: boolean
  onChange: (value: string) => void
}

function IssueDefault({
  id,
  label,
  hint,
  unsetLabel,
  value,
  options,
  disabled,
  onChange,
}: IssueDefaultProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || UNSET} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>{unsetLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

export function ParsecConfig({ integrationId, initialConfig, enabled }: ParsecConfigProps) {
  const updateMutation = useUpdateIntegration()
  const [projects, setProjects] = useState<ParsecProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState((initialConfig.channelId as string) || '')
  const [externalStatuses, setExternalStatuses] = useState<ExternalStatus[]>([])
  const [integrationEnabled, setIntegrationEnabled] = useState(enabled)
  const [projectRef, setProjectRef] = useState((initialConfig.projectRef as string) || '')
  const [issueOptions, setIssueOptions] = useState<ParsecIssueOptions>({
    issueTypes: [],
    members: [],
  })
  const [issueTypeId, setIssueTypeId] = useState((initialConfig.issueTypeId as string) || '')
  const [issuePriority, setIssuePriority] = useState((initialConfig.issuePriority as string) || '')
  const [watcherUserId, setWatcherUserId] = useState((initialConfig.watcherUserId as string) || '')

  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true)
    setProjectError(null)
    try {
      setProjects(await fetchParsecProjectsFn())
    } catch {
      setProjectError('Failed to load projects. Please try again.')
    } finally {
      setLoadingProjects(false)
    }
  }, [])

  const fetchStatuses = useCallback(() => {
    fetchExternalStatusesFn({ data: { integrationType: 'parsec' } })
      .then(setExternalStatuses)
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchStatuses()
  }, [fetchProjects, fetchStatuses])

  useEffect(() => {
    if (!projectRef) return
    fetchParsecIssueOptionsFn({ data: { projectRef } })
      .then(setIssueOptions)
      .catch(() => {})
  }, [projectRef])

  const handleEnabledChange = (checked: boolean) => {
    setIntegrationEnabled(checked)
    updateMutation.mutate({ id: integrationId, enabled: checked })
  }

  const handleProjectChange = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    setSelectedProject(projectId)
    setProjectRef(project.ref)
    // Types and members belong to a project, so the old choices go with it.
    setIssueTypeId('')
    setWatcherUserId('')
    updateMutation.mutate(
      {
        id: integrationId,
        config: {
          channelId: projectId,
          projectRef: project.ref,
          issueTypeId: '',
          watcherUserId: '',
        },
      },
      { onSuccess: fetchStatuses }
    )
  }

  const saveIssueDefault = (key: string, value: string, apply: (next: string) => void) => {
    const next = value === UNSET ? '' : value
    apply(next)
    updateMutation.mutate({ id: integrationId, config: { [key]: next } })
  }

  const saving = updateMutation.isPending

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="enabled-toggle" className="text-base font-medium">
            Integration enabled
          </Label>
          <p className="text-xs text-muted-foreground">
            Turn off to pause all Parsec issue syncing
          </p>
        </div>
        <Switch
          id="enabled-toggle"
          checked={integrationEnabled}
          onCheckedChange={handleEnabledChange}
          disabled={saving}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="project-select">Project</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchProjects}
            disabled={loadingProjects}
            className="h-8 gap-1.5 text-xs"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${loadingProjects ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        {projectError ? (
          <p className="text-sm text-destructive">{projectError}</p>
        ) : (
          <Select
            value={selectedProject}
            onValueChange={handleProjectChange}
            disabled={loadingProjects || saving || !integrationEnabled}
          >
            <SelectTrigger id="project-select" className="w-full">
              {loadingProjects ? (
                <div className="flex items-center gap-2">
                  <ArrowPathIcon className="h-4 w-4 animate-spin" />
                  <span>Loading projects...</span>
                </div>
              ) : (
                <SelectValue placeholder="Select a project" />
              )}
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <div className="flex items-center gap-2">
                    <FolderIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{project.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-xs text-muted-foreground">
          Issues created from tickets land in this project. Change it before turning on status sync.
        </p>
      </div>

      <div className="space-y-4">
        <Label className="text-base font-medium">New issues</Label>
        <IssueDefault
          id="issue-type-select"
          label="Issue type"
          hint="Issues created from tickets get this type."
          unsetLabel="Project default"
          value={issueTypeId}
          options={issueOptions.issueTypes}
          disabled={saving || !integrationEnabled || !projectRef}
          onChange={(v) => saveIssueDefault('issueTypeId', v, setIssueTypeId)}
        />
        <IssueDefault
          id="issue-priority-select"
          label="Priority"
          hint="Issues created from tickets start with this priority."
          unsetLabel="No priority"
          value={issuePriority}
          options={PRIORITIES}
          disabled={saving || !integrationEnabled}
          onChange={(v) => saveIssueDefault('issuePriority', v, setIssuePriority)}
        />
        <IssueDefault
          id="issue-watcher-select"
          label="Watcher"
          hint="This person watches every new issue and gets a comment on it, so Parsec notifies them."
          unsetLabel="Nobody"
          value={watcherUserId}
          options={issueOptions.members}
          disabled={saving || !integrationEnabled || !projectRef}
          onChange={(v) => saveIssueDefault('watcherUserId', v, setWatcherUserId)}
        />
      </div>

      {saving && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
          <span>Saving...</span>
        </div>
      )}

      {updateMutation.isError && (
        <div className="text-sm text-destructive">
          {updateMutation.error?.message || 'Failed to save changes'}
        </div>
      )}

      <StatusSyncConfig
        integrationId={integrationId}
        integrationType="parsec"
        config={initialConfig}
        enabled={integrationEnabled}
        externalStatuses={externalStatuses}
      />

      <TicketStatusSyncConfig
        integrationId={integrationId}
        config={initialConfig}
        enabled={integrationEnabled}
        externalStatuses={externalStatuses}
      />
    </div>
  )
}
