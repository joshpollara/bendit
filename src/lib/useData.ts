import { useEffect, useState } from 'react';
import { useUI } from '../store/ui';

// Fetches server data and re-fetches whenever the global revision bumps
// (i.e. after any mutation). Returns undefined while loading.
export function useData<T>(fn: () => Promise<T>, deps: unknown[]): T | undefined {
  const revision = useUI((s) => s.revision);
  const [data, setData] = useState<T>();

  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // fn is intentionally excluded: its behavior is fully determined by deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, ...deps]);

  return data;
}
