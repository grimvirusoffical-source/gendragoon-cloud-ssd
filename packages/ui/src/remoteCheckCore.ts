/** The React hooks the check needs. React Native passes its own React, so one app never loads two copies. */
export interface HookSet {
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
  useState: <S>(initial: S) => [S, (next: S) => void];
}

/**
 * Debounced real-time server check for one field (username availability, email deliverability).
 * Only an answer for the value that is on screen now counts: every new value starts a new request
 * number, and an answer is kept only if it belongs to the newest request and its value still matches.
 * A slow answer for an older value can never land on the newer one. Codes in `ignore` (temporary
 * failures such as `email_unverifiable`) don't block the form; the server checks again on submit.
 * Shared by the desktop/web form and the mobile screen (`makeUseRemoteCheck(React)`).
 */
export type RemoteCheckOptions = { enabled: boolean; delayMs: number; check: (value: string) => Promise<{ ok: boolean; error?: string }>; ignore?: readonly string[] };

export function makeUseRemoteCheck({ useEffect, useRef, useState }: HookSet) {
  return function useRemoteCheck(value: string, options: RemoteCheckOptions): string | undefined {
    const { enabled, delayMs } = options;
    const checkRef = useRef(options.check);
    useEffect(() => {
      checkRef.current = options.check;
    });
    const seq = useRef(0);
    const [answer, setAnswer] = useState<{ value: string; error?: string } | null>(null);
    useEffect(() => {
      const id = ++seq.current;
      if (!enabled) return;
      const timer = setTimeout(() => {
        checkRef.current(value)
          .then((r) => { if (id === seq.current) setAnswer({ value, error: r.ok ? undefined : r.error }); })
          .catch(() => undefined);
      }, delayMs);
      return () => clearTimeout(timer);
    }, [value, enabled, delayMs]);
    if (!enabled || !answer || answer.value !== value || !answer.error) return undefined;
    return options.ignore?.includes(answer.error) ? undefined : answer.error;
  };
}
