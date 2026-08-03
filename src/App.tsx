import { useLiveQuery } from 'dexie-react-hooks';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { getProfile } from './db/db';
import type { Profile } from './types';
import { STRINGS } from './lib/strings';
import TabBar from './components/TabBar';
import Onboarding from './screens/Onboarding';
import Today from './screens/Today';
import AddFood from './screens/AddFood';
import AddExercise from './screens/AddExercise';
import Weight from './screens/Weight';
import More from './screens/More';

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-8">
      <h1 className="text-4xl font-bold tracking-tight">
        Bend It<span className="text-amber">!</span>
      </h1>
      <p className="text-center text-sm text-ink-muted">{STRINGS.splash}</p>
    </div>
  );
}

function Shell({ profile }: { profile: Profile }) {
  return (
    <BrowserRouter>
      <div className="mx-auto min-h-dvh w-full max-w-md pb-28">
        <Routes>
          <Route path="/" element={<Today profile={profile} />} />
          <Route path="/add-food" element={<AddFood />} />
          <Route path="/add-exercise" element={<AddExercise profile={profile} />} />
          <Route path="/weight" element={<Weight profile={profile} />} />
          <Route path="/more" element={<More profile={profile} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <TabBar />
      </div>
    </BrowserRouter>
  );
}

export default function App() {
  const profile = useLiveQuery(getProfile, [], 'loading' as const);
  if (profile === 'loading') return <Splash />;
  if (!profile) return <Onboarding />;
  return <Shell profile={profile} />;
}
