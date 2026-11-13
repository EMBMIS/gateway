import { useState } from 'react'
import { ClipboardIcon, CheckIcon } from '@heroicons/react/20/solid'

/** A command or snippet with a copy button. Mono, selectable, scrolls sideways inside itself, never the page. */
export default function CodeBlock({ code, label }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* the text is selectable */ }
  }
  return (
    <div className="relative rounded-lg border border-ink-200 bg-sunken">
      <button type="button" onClick={copy} aria-label={label ? `Copy ${label}` : 'Copy'} className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 text-xs text-ink-700 hover:bg-ink-100">
        {done ? <CheckIcon className="h-3.5 w-3.5 text-ok-600" aria-hidden="true" /> : <ClipboardIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        {done ? 'Copied' : 'Copy'}
      </button>
      <pre className="overflow-x-auto p-3 pr-20 font-mono text-xs leading-relaxed text-fg ui-scroll"><code>{code}</code></pre>
    </div>
  )
}
