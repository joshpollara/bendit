import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, UNAUTHORIZED_EVENT } from './lib/api';
import { useData } from './lib/useData';
import type { Profile } from './types';
import { STRINGS } from './lib/strings';
import TabBar from './components/TabBar';
import SideNav from './components/SideNav';
import Login from './screens/Login';
import Onboarding from './screens/Onboarding';
import Today from './screens/Today';
import AddFood from './screens/AddFood';
import AddExercise from './screens/AddExercise';
import Weight from './screens/Weight';
import Foods from './screens/Foods';
import Recipes from './screens/Recipes';
import Reports from './screens/Reports';
import Menu from './screens/Menu';
import Settings from './screens/Settings';

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
      <div className="mx-auto flex min-h-dvh w-full max-w-md gap-8 pb-28 md:max-w-6xl xl:max-w-7xl md:gap-8 md:px-6 md:py-8 md:pb-8 lg:gap-10">
        <SideNav />
        <main className="w-full min-w-0 flex-1">
          <Routes>
            <Route path="/" element={<Today profile={profile} />} />
            <Route path="/add-food" element={<AddFood />} />
            <Route path="/add-exercise" element={<AddExercise profile={profile} />} />
            <Route path="/weight" element={<Weight profile={profile} />} />
            <Route path="/reports" element={<Reports profile={profile} />} />
            <Route path="/foods" element={<Foods />} />
            <Route path="/recipes" element={<Recipes />} />
            <Route path="/more" element={<Menu />} />
            <Route path="/settings" element={<Settings profile={profile} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <TabBar />
      </div>
    </BrowserRouter>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .session()
      .then((s) => setAuthed(s.authed))
      .catch(() => setAuthed(false));
    // A session that expires mid-use drops straight back to the login screen
    // rather than leaving a half-loaded app behind.
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (authed === null) return <Splash />;
  if (!authed) return <Login onSignedIn={() => setAuthed(true)} />;
  return <SignedIn />;
}

function SignedIn() {
  const profile = useData(() => api.getProfile(), []);
  if (profile === undefined) return <Splash />;
  if (profile === null) return <Onboarding />;
  return <Shell profile={profile} />;
}
