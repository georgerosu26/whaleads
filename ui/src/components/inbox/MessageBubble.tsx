import { AlertTriangle, Check, CheckCheck, Clock, FileText, ImageOff } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { clock, type Msg } from '@/lib/inbox'

function Tick({ m }: { m: Msg }) {
  if (m.direction !== 'out') return null
  if (m.local?.state === 'sending') return <Clock aria-label="Sending" className="h-3 w-3" />
  if (m.local?.state === 'failed' || m.status === 'failed') return <AlertTriangle aria-label="Failed" className="h-3 w-3 text-danger" />
  if (m.status === 'read') return <CheckCheck aria-label="Read" className="h-3 w-3 text-accent" />
  if (m.status === 'delivered') return <CheckCheck aria-label="Delivered" className="h-3 w-3" />
  return <Check aria-label="Sent" className="h-3 w-3" />
}

const size = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`)

// media variants. Served from /api/media/:messageId behind the session cookie.
function Media({ m }: { m: Msg }) {
  const [broken, setBroken] = useState(false)
  const media = m.media
  const url = m.local?.previewUrl ?? `/api/media/${m.id}`
  const kind = m.type === 'template' ? (media?.mime?.startsWith('image/') ? 'image' : media?.mime?.startsWith('video/') ? 'video' : 'document') : m.type
  const label = media?.filename ?? `${kind} attachment`
  const gone = media?.status === 'failed' || media?.status === 'too_large' || broken
  if (!media || gone) {
    return (
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <ImageOff aria-hidden className="h-4 w-4 shrink-0" />
        <span>{media?.status === 'too_large' ? 'File too large to keep. Open it on the phone.' : `${label} is only on the phone`}</span>
      </div>
    )
  }
  if (kind === 'image' || kind === 'sticker') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="mb-1 block overflow-hidden rounded-lg" aria-label="Open image">
        <img src={url} alt={m.body ?? 'Image'} loading="lazy" onError={() => setBroken(true)} className="max-h-72 w-full object-cover" />
      </a>
    )
  }
  if (kind === 'audio') return <audio controls preload="none" src={url} className="mb-1 h-10 w-full max-w-full" onError={() => setBroken(true)} />
  if (kind === 'video') return <video controls preload="metadata" src={`${url}#t=0.1`} className="mb-1 max-h-72 w-full rounded-lg bg-black" onError={() => setBroken(true)} />
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="mb-1 flex min-h-[44px] items-center gap-2 rounded-lg bg-background/60 px-3 py-2 text-xs font-semibold hover:bg-background">
      <FileText aria-hidden className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground">{size(media.size)}</span>
    </a>
  )
}

export function MessageBubble({ m, onRetry }: { m: Msg; onRetry?: () => void }) {
  const out = m.direction === 'out'
  const isText = !m.type || m.type === 'text'
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[75%]', out ? 'rounded-br-sm bg-accent/15' : 'rounded-bl-sm border bg-surface')}>
        {m.type === 'template' && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Template</p>}
        {!isText && (m.type !== 'template' || m.media) && <Media m={m} />}
        {m.body && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{isText ? m.body : m.body.replace(/^\[[a-z]+\]\s*/i, '')}</p>}
        {!m.body && isText && <p className="italic text-muted-foreground">Empty message</p>}
        {m.local?.state === 'sending' && m.media && <p className="mt-1 text-xs text-muted-foreground" data-testid="uploading">Uploading{m.media.size ? ` ${size(m.media.size)}` : ''}…</p>}
        {m.local?.state === 'failed' && (
          <button type="button" onClick={onRetry} className="mt-1 block min-h-[44px] w-full text-left text-xs font-semibold text-danger underline" data-testid="retry-send">
            Not sent{m.local.error ? `: ${m.local.error}` : ''}. Tap to retry
          </button>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          <time>{clock(m.timestamp)}</time><Tick m={m} />
        </div>
      </div>
    </div>
  )
}
