import { FormattedMessage } from 'react-intl'
import { SOURCE_CODE_URL } from '@/lib/shared/source-code'

/** FeedbackOS: the source of the running version, offered to every user as
 *  the AGPL (section 13) requires. Pinned under the feedback filters. */
export function PortalSourceCodeLink() {
  return (
    <div className="flex justify-center mt-3">
      <a
        href={SOURCE_CODE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <FormattedMessage id="portal.feedback.sidebar.sourceCode" defaultMessage="Source code" />
      </a>
    </div>
  )
}
