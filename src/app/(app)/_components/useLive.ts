"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const FALLBACK_POLL_MS = 30_000;
const REFETCH_DEBOUNCE_MS = 150;

/**
 * Loads JSON from `url` and keeps it fresh: any Server-Sent Event on
 * `eventsUrl` triggers a (debounced) refetch. If SSE drops, it polls.
 */
export function useLive<T>(url: string, eventsUrl: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api<T>(url));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await api<T>(url);
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
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
  }, [url, eventsUrl]);

  return { data, error, live, refresh };
}
