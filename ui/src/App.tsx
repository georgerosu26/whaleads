import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { ErrorState } from '@/components/ErrorState'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import ChangePassword from '@/pages/ChangePassword'
import Inbox from '@/pages/Inbox'
import Login from '@/pages/Login'
import Recover from '@/pages/Recover'
import Setup from '@/pages/Setup'
import Today from '@/pages/Today'
import Leads from '@/pages/Leads'
import LeadDetail from '@/pages/LeadDetail'
import NewLead from '@/pages/NewLead'
import Contacts from '@/pages/Contacts'
import SettingsHome from '@/pages/settings/Home'
import Profile from '@/pages/settings/Profile'
import Business from '@/pages/settings/Business'
import Team from '@/pages/settings/Team'
import Pipeline from '@/pages/settings/Pipeline'
import Forms from '@/pages/settings/Forms'
import WhatsApp from '@/pages/settings/WhatsApp'
import AI from '@/pages/settings/AI'
import QuickReplies from '@/pages/settings/QuickReplies'
import Templates from '@/pages/settings/Templates'
import TemplateCreate from '@/pages/settings/TemplateCreate'
import FlowsList from '@/pages/flows/FlowsList'
import FlowEditor from '@/pages/flows/FlowEditor'
import BroadcastsList from '@/pages/broadcasts/List'
import BroadcastWizard from '@/pages/broadcasts/Wizard'
import BroadcastDetail from '@/pages/broadcasts/Detail'
import Reports from '@/pages/Reports'
import Data from '@/pages/settings/Data'

function BootSkeleton() {
  return (
    <div className="flex h-full" aria-busy="true" aria-label="Loading">
      <div className="hidden w-60 space-y-3 border-r bg-surface p-4 md:block"><Skeleton className="h-6 w-32" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      <div className="flex-1 space-y-4 p-6"><Skeleton className="h-7 w-40" /><Skeleton className="h-40" /></div>
    </div>
  )
}

export default function App() {
  const { state, reload } = useAuth()
  if (state.status === 'loading') return <BootSkeleton />
  if (state.status === 'error') return <div className="mx-auto max-w-md p-6"><ErrorState message={state.message} onRetry={reload} /></div>
  if (state.status === 'anon') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/recover" element={<Recover />} />
        <Route path="*" element={<Navigate to={state.needsSetup ? '/setup' : '/login'} replace />} />
      </Routes>
    )
  }
  if (state.me.staff.must_change_pw) return <ChangePassword />
  return (
    <Routes>
      <Route element={<AppShell me={state.me} />}>
        <Route index element={<Today />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:contactId" element={<Inbox />} />
        <Route path="leads" element={<Leads />} />
        <Route path="leads/new" element={<NewLead />} />
        <Route path="leads/:id" element={<LeadDetail />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="automations" element={<FlowsList />} />
        <Route path="automations/:id" element={<FlowEditor />} />
        <Route path="broadcasts" element={<BroadcastsList />} />
        <Route path="broadcasts/:id" element={<BroadcastDetail />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<SettingsHome />} />
        <Route path="settings/profile" element={<Profile />} />
        <Route path="settings/quick-replies" element={<QuickReplies />} />{/* all staff */}
        <Route path="settings/templates" element={<Templates />} />{/* all staff list/sync; create is admin */}
        {state.me.staff.role === 'admin' && (
          <>
            <Route path="broadcasts/new" element={<BroadcastWizard />} />
            <Route path="broadcasts/:id/edit" element={<BroadcastWizard />} />
            <Route path="settings/business" element={<Business />} />
            <Route path="settings/team" element={<Team />} />
            <Route path="settings/pipeline" element={<Pipeline />} />
            <Route path="settings/forms" element={<Forms />} />
            <Route path="settings/whatsapp" element={<WhatsApp />} />
            <Route path="settings/ai" element={<AI />} />
            <Route path="settings/templates/new" element={<TemplateCreate />} />
            <Route path="settings/data" element={<Data />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
