"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { loadBundle, saveBundle } from "./offlineStore";

const FALLBACK_POLL_MS = 30_000;
const REFETCH_DEBOUNCE_MS = 150;

/**
 * Loads JSON from `url` and keeps it fresh: any Server-Sent Event on
 * `eventsUrl` triggers a (debounced) refetch. If SSE drops, it polls.
 */
export function useLive<T>(url: string, eventsUrl: string, persistKey?: string) {
  const [data, setData] = useState<T | null>(null);
  /** Set when showing the device's saved copy because the network failed. */
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api<T>(url);
      setData(d);
      setOfflineSince(null);
      setError(null);
      if (persistKey) saveBundle(persistKey, d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url, persistKey]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await api<T>(url);
        if (!cancelled) {
          setData(d);
          setOfflineSince(null);
          setError(null);
          if (persistKey) saveBundle(persistKey, d);
        }
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        // A network failure (not an auth/404 answer) falls back to the device's saved copy.
        if (persistKey && e instanceof TypeError) {
          const saved = await loadBundle<T>(persistKey);
          if (saved && !cancelled) {
            setData((cur) => cur ?? saved.bundle);
            setOfflineSince(saved.savedAt);
          }
        }
      }
    };
    load();
    const es = new EventSource(eventsUrl);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, REFETCH_DEBOUNCE_MS);
    };
    const poll = setInterval(() => {
      if (es.readyState !== EventSource.OPEN) load();
    }, FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      es.close();
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [url, eventsUrl, persistKey]);

  return { data, error, live, refresh, offlineSince };
}
