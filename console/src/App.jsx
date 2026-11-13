import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './lib/workspace'
import { ToastHost, Skeleton } from './components/ui'
import Shell from './components/shell/Shell'

const page = (loader) => lazy(loader)
const Login = page(() => import('./pages/Auth').then((m) => ({ default: m.Login })))
const Register = page(() => import('./pages/Auth').then((m) => ({ default: m.Register })))
const Dashboard = page(() => import('./pages/Dashboard'))
const Alerts = page(() => import('./pages/Alerts'))
const Decisions = page(() => import('./pages/Decisions'))
const Queue = page(() => import('./pages/Queue'))
const Audit = page(() => import('./pages/Audit'))
const Agents = page(() => import('./pages/Agents'))
const Policies = page(() => import('./pages/Policies'))
const Tester = page(() => import('./pages/Tester'))
const Compliance = page(() => import('./pages/Compliance'))
const Vault = page(() => import('./pages/Vault'))
const Connect = page(() => import('./pages/Connect'))
const Keys = page(() => import('./pages/Keys'))
const Usage = page(() => import('./pages/Usage'))
const Settings = page(() => import('./pages/Settings'))
const Onboarding = page(() => import('./pages/Onboarding'))
const NotFound = page(() => import('./pages/NotFound'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
})

function Loading() {
  return <div className="space-y-3 p-6" role="status"><span className="sr-only">Loading</span><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-80" /><Skeleton className="h-40 w-full" /></div>
}

function Protected() {
  const { user } = useAuth()
  const location = useLocation()
  if (user === undefined) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Shell />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter basename={(import.meta.env.BASE_URL || '/').replace(/\/+$/, '') || undefined}>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route element={<Protected />}>
                <Route index element={<Dashboard />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="decisions" element={<Decisions />} />
                <Route path="decisions/queue" element={<Queue />} />
                <Route path="decisions/audit" element={<Audit />} />
                <Route path="agents" element={<Agents />} />
                <Route path="policies" element={<Policies />} />
                <Route path="policies/tester" element={<Tester />} />
                <Route path="compliance" element={<Compliance />} />
                <Route path="compliance/vault" element={<Vault />} />
                <Route path="connect" element={<Connect />} />
                <Route path="connect/keys" element={<Keys />} />
                <Route path="usage" element={<Usage />} />
                <Route path="settings" element={<Settings />} />
                <Route path="onboarding" element={<Onboarding />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
        <ToastHost />
      </AuthProvider>
    </QueryClientProvider>
  )
}
