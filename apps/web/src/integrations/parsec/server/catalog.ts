import type { IntegrationCatalogEntry } from '@/lib/server/integrations/types'

export const parsecCatalog: IntegrationCatalogEntry = {
  id: 'parsec',
  name: 'Parsec',
  description: 'Create Parsec issues from tickets and carry their status back.',
  category: 'issue_tracking',
  iconBg: 'bg-[#4F46E5]',
  settingsPath: '/admin/settings/integrations/parsec',
  available: true,
  configurable: false,
}
