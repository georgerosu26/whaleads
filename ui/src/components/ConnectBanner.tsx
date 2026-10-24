import { useLocation } from 'react-router-dom'
import { ConnectButton } from '@/components/ConnectButton'
import { useConnection } from '@/lib/connection'

/** Shown on every signed-in page until a WhatsApp number is connected. No dismiss: it goes away when connected. */
export function ConnectBanner() {
  const { connected, isAdmin } = useConnection()
  const path = useLocation().pathname.replace(/\/+$/, '')
  if (connected || path === '/settings/whatsapp') return null
  return (
    <div role="status" data-testid="connect-banner" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
      <p className="min-w-0 break-words">
        <strong className="font-semibold">No WhatsApp number is connected.</strong> Messages can't arrive or be sent yet.
        {!isAdmin && <> Ask an administrator to connect a WhatsApp number.</>}
      </p>
      {isAdmin && <ConnectButton />}
    </div>
  )
}
