import { BellRing, Share, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { isIos, isStandalone, useInstallPrompt, usePush } from '@/lib/push'

const KEY = 'wl:install-hint-dismissed'
const read = () => { try { return Number(localStorage.getItem(KEY) ?? 0) } catch { return 0 } }

/** Shown until push is on. iOS only delivers push to the installed app, so there it explains Add to Home Screen. */
export function InstallAppHint({ always = false }: { always?: boolean }) {
  const { state } = usePush()
  const onProfile = useLocation().pathname === '/settings/profile' // the card is right there
  const { canPrompt, prompt } = useInstallPrompt()
  const [hidden, setHidden] = useState(() => !always && Date.now() - read() < 7 * 86400_000)
  if (hidden || (onProfile && !always) || state.kind === 'checking' || state.kind === 'on' || state.kind === 'denied') return null
  if (state.kind === 'unsupported' && state.reason === 'no_support') return null
  const ios = isIos() && !isStandalone()
  const close = () => { try { localStorage.setItem(KEY, String(Date.now())) } catch { /* private mode */ } setHidden(true) }

  return (
    <div role="region" aria-label="Get notifications" className="flex items-start gap-3 border-b bg-muted px-4 py-2.5">
      {ios ? <Share aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <BellRing aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
      <p className="min-w-0 flex-1 text-sm">
        {ios
          ? <>On iPhone, notifications work once WhaLeads is on your Home Screen. Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, and open it from there.</>
          : <>Get a notification on this device for every new lead and message. <Link to="/settings/profile" className="font-semibold underline">Turn on notifications</Link></>}
      </p>
      {!ios && canPrompt && <Button type="button" variant="secondary" className="min-h-[32px] shrink-0 px-3" onClick={() => void prompt()}>Install app</Button>}
      {!always && <button type="button" aria-label="Dismiss" onClick={close} className="-m-2 shrink-0 p-2 text-muted-foreground hover:text-foreground"><X aria-hidden className="h-4 w-4" /></button>}
    </div>
  )
}
