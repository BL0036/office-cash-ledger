import { useEffect, useState } from 'react';

/**
 * Phase 7: counts down a wrong-PIN delay for the lock screen.
 * `initialMs` resumes a delay that was still running when the page loaded
 * (the delay is persisted, so a reload can't be used to skip it).
 * `start(ms)` begins a new one; `secondsLeft` is 0 when no delay is active.
 * Date.now() is only read in event handlers / the interval callback and in
 * the one-time state initializers, never on later renders.
 */
export function useRetryCountdown(initialMs = 0): { secondsLeft: number; start: (ms: number) => void } {
  const [until, setUntil] = useState(() => (initialMs > 0 ? Date.now() + initialMs : 0));
  const [secondsLeft, setSecondsLeft] = useState(() => (initialMs > 0 ? Math.ceil(initialMs / 1000) : 0));

  useEffect(() => {
    if (until === 0) return;
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setUntil(0);
    }, 250);
    return () => clearInterval(id);
  }, [until]);

  return {
    secondsLeft,
    start: (ms: number) => {
      setUntil(Date.now() + ms);
      setSecondsLeft(Math.ceil(ms / 1000));
    },
  };
}
