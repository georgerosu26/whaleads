import { PlugZap } from 'lucide-react'
import { Link } from 'react-router-dom'

/** A link styled like the primary Button: it navigates to the WhatsApp settings page (admins only are shown it). */
export function ConnectButton() {
  return (
    <Link to="/settings/whatsapp" data-testid="connect-whatsapp"
      className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <PlugZap aria-hidden className="h-4 w-4" />Connect WhatsApp
    </Link>
  )
}
