import { useEffect, useState } from 'react';

/**
 * The current time, re-read every second while `running` is true. Only a
 * counting clock needs this; anything else would be re-rendering for nothing.
 */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  return now;
}
