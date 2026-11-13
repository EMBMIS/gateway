import { Suspense, lazy, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Button, Field, Input, InlineNotice, ErrorSummary } from '../components/ui'
import { useAuth } from '../lib/workspace'
import { explain } from '../lib/api'

const Symbiote = lazy(() => import('../components/symbiote/Symbiote'))

/** Login and register share one frame: the pitch on one side (honest, no numbers), the form on the other. */
function AuthFrame({ title, intro, children, footer }) {
  return (
    <div className="grid min-h-[100dvh] bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)]">
      <aside className="relative hidden overflow-hidden border-r border-ink-200 bg-sunken lg:block" aria-hidden="true">
        <div className="absolute inset-0 flex items-center justify-center">
          <Suspense fallback={null}><Symbiote state="idle" className="h-full w-full" /></Suspense>
        </div>
        <div className="relative z-10 flex h-full flex-col justify-between p-10">
          <div className="flex items-center gap-2"><img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="" width={26} height={26} className="rounded" /><span className="text-sm font-semibold text-fg">EMBMIS Gateway</span></div>
          <div className="max-w-md">
            <p className="label-mono mb-2">Allow · Deny · Escalate</p>
            <p className="text-2xl font-semibold tracking-tight text-fg">Every action an AI takes is checked before it happens.</p>
          </div>
        </div>
      </aside>
      <main id="main" className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden"><img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="" width={24} height={24} className="rounded" /><span className="text-sm font-semibold text-fg">EMBMIS Gateway</span></div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          <p className="mt-1.5 text-sm text-ink-600">{intro}</p>
          <div className="mt-6">{children}</div>
          <p className="mt-6 text-sm text-ink-600">{footer}</p>
        </div>
      </main>
    </div>
  )
}

function useRedirectIfSignedIn() {
  const { user } = useAuth()
  const location = useLocation()
  if (user) return <Navigate to={location.state?.from || '/'} replace />
  return null
}

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const redirect = useRedirectIfSignedIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (redirect) return redirect

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !password) { setError('Enter your email and password.'); return }
    setBusy(true)
    try {
      await login(email.trim(), password)
      navigate(location.state?.from || '/', { replace: true })
    } catch (err) {
      setError(err.status === 401 ? 'That email and password do not match an account. Check them, or create an account.' : explain(err))
    } finally { setBusy(false) }
  }

  return (
    <AuthFrame title="Sign in" intro="Open your workspace's decisions, policies and agents." footer={<>New here? <Link to="/register" className="font-medium text-brand-600 underline-offset-2 hover:underline">Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <ErrorSummary errors={{ form: error }} title="That did not work" />}
        <Field label="Email" required><Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field label="Password" required><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" variant="primary" block loading={busy}>Sign in</Button>
      </form>
    </AuthFrame>
  )
}

export function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const redirect = useRedirectIfSignedIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (redirect) return redirect

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address.'); return }
    if (password.length < 8) { setError('Choose a password of at least 8 characters.'); return }
    setBusy(true)
    try {
      const r = await register(email.trim(), password)
      navigate('/onboarding', { replace: true, state: { workspaceKey: r.apiKey } })
    } catch (err) {
      setError(err.status === 409 ? 'An account with this email already exists. Sign in instead.' : err.status === 429 ? 'Too many attempts. Wait a minute and try again.' : explain(err))
    } finally { setBusy(false) }
  }

  return (
    <AuthFrame title="Create your workspace" intro="One account, one workspace. Add your agents and policies next." footer={<>Already have an account? <Link to="/login" className="font-medium text-brand-600 underline-offset-2 hover:underline">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <ErrorSummary errors={{ form: error }} title="That did not work" />}
        <Field label="Work email" required><Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field label="Password" required hint="At least 8 characters."><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" variant="primary" block loading={busy}>Create workspace</Button>
        <InlineNotice tone="ink">Your workspace starts empty. Nothing is pre-filled with sample data.</InlineNotice>
      </form>
    </AuthFrame>
  )
}
