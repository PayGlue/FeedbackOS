'use client'

import { useState } from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { saveParsecConnectionFn } from '@/integrations/parsec/server/functions'
import { useDeleteIntegration } from '@/lib/client/mutations'
import { useQueryClient } from '@tanstack/react-query'

interface ParsecConnectionActionsProps {
  integrationId?: string
  isConnected: boolean
}

export function ParsecConnectionActions({
  integrationId,
  isConnected,
}: ParsecConnectionActionsProps) {
  const queryClient = useQueryClient()
  const deleteMutation = useDeleteIntegration()
  const [apiUrl, setApiUrl] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false)

  const canSave = apiUrl.trim() && webUrl.trim() && apiKey.trim()

  const handleSaveToken = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await saveParsecConnectionFn({
        data: { apiUrl: apiUrl.trim(), webUrl: webUrl.trim(), apiKey: apiKey.trim() },
      })
      setApiKey('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'integrations'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setSaving(false)
    }
  }

  const handleDisconnect = () => {
    if (!integrationId) return
    deleteMutation.mutate({ id: integrationId })
  }

  const disconnecting = deleteMutation.isPending

  return (
    <>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {!isConnected && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="parsec-api-url" className="text-sm">
              API address
            </Label>
            <Input
              id="parsec-api-url"
              type="url"
              placeholder="https://api.example.com"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              disabled={saving}
              className="w-80"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="parsec-web-url" className="text-sm">
              Web address
            </Label>
            <Input
              id="parsec-web-url"
              type="url"
              placeholder="https://tracker.example.com"
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
              disabled={saving}
              className="w-80"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="parsec-api-key" className="text-sm">
              API key
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="parsec-api-key"
                type="password"
                placeholder="Paste your Parsec API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={saving}
                className="w-64"
              />
              <Button onClick={handleSaveToken} disabled={saving || !canSave}>
                {saving ? (
                  <>
                    <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {isConnected && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disconnecting}
            onClick={() => setDisconnectDialogOpen(true)}
          >
            {disconnecting ? (
              <>
                <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
                Disconnecting...
              </>
            ) : (
              'Disconnect'
            )}
          </Button>
          <ConfirmDialog
            open={disconnectDialogOpen}
            onOpenChange={setDisconnectDialogOpen}
            title="Disconnect Parsec?"
            description="This will remove the Parsec integration and stop all issue syncing. You can reconnect at any time."
            confirmLabel="Disconnect"
            isPending={disconnecting}
            onConfirm={handleDisconnect}
          />
        </div>
      )}
    </>
  )
}
