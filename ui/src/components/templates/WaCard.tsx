import { FileText, Film, Image as ImageIcon } from 'lucide-react'
import { renderParams } from '../../../../src/templateRules'
import type { HeaderFormat } from '@/lib/templates'

/** A WhatsApp-style message card. Values replace {{n}}; a missing value shows the placeholder itself. */
export function WaCard({ header, headerText, headerImageUrl, body, footer, button, samples = [], headerSamples = [] }: {
  header: HeaderFormat; headerText?: string | null; headerImageUrl?: string | null; body: string; footer?: string | null; /** Copy-code button label (authentication preview). */ button?: string
  samples?: string[]; headerSamples?: string[]
}) {
  const Icon = header === 'VIDEO' ? Film : header === 'DOCUMENT' ? FileText : ImageIcon
  return (
    <div className="rounded-xl bg-[hsl(var(--muted))] p-3" data-testid="wa-card">
      <div className="max-w-[300px] overflow-hidden rounded-lg rounded-tl-sm bg-surface text-sm shadow-sm">
        {header === 'TEXT' && headerText && <p className="px-3 pt-2 font-bold [overflow-wrap:anywhere]">{renderParams(headerText, headerSamples)}</p>}
        {(header === 'IMAGE' || header === 'VIDEO' || header === 'DOCUMENT') && (
          headerImageUrl && header === 'IMAGE'
            ? <img src={headerImageUrl} alt="Header sample" className="max-h-40 w-full object-cover" />
            : <div className="flex h-24 items-center justify-center bg-muted text-muted-foreground"><Icon aria-hidden className="h-8 w-8" /></div>
        )}
        <p className="whitespace-pre-wrap px-3 py-2 [overflow-wrap:anywhere]">{body ? renderParams(body, samples) : <span className="text-muted-foreground">Your message appears here.</span>}</p>
        {footer && <p className="px-3 pb-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{footer}</p>}
        {button && <p className="border-t px-3 py-2 text-center text-sm font-semibold text-accent [overflow-wrap:anywhere]">{button}</p>}
      </div>
    </div>
  )
}
