import { FormattedMessage } from 'react-intl'
import { Avatar } from '@/components/ui/avatar'
import type { ThreadHumanAgent } from '@/lib/shared/conversation/human-agent'

interface MessengerIdentityProps {
  /** The AI assistant fronting the messenger. */
  assistant: { name: string; avatarUrl: string | null }
  /** The teammate who has taken over the thread, if any. */
  humanAgent?: ThreadHumanAgent | null
  avatarClassName?: string
}

/**
 * Who the visitor is talking to, for the messenger header: the assistant while
 * the thread is AI-first, the teammate once a human has replied. The other
 * party stays named in the subtitle, so the visitor knows both can answer.
 */
export function MessengerIdentity({
  assistant,
  humanAgent,
  avatarClassName = 'size-8 text-xs',
}: MessengerIdentityProps) {
  const name = humanAgent ? (humanAgent.name ?? assistant.name) : assistant.name
  const avatarUrl = humanAgent ? humanAgent.avatarUrl : assistant.avatarUrl
  return (
    <>
      <Avatar src={avatarUrl} name={name} className={avatarClassName} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold leading-tight text-foreground">{name}</p>
        <p className="truncate text-[11px] leading-tight text-muted-foreground">
          {humanAgent ? (
            <FormattedMessage
              id="widget.messenger.assistant.alsoHelps"
              defaultMessage="{name} can also help"
              values={{ name: assistant.name }}
            />
          ) : (
            <FormattedMessage
              id="widget.messenger.assistant.teamAlso"
              defaultMessage="The team can also help"
            />
          )}
        </p>
      </div>
    </>
  )
}
