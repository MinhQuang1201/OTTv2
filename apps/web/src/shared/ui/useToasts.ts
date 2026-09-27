import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}
export interface UseToastsOptions {
  maxToasts?: number;
  duration?: number;
}

let nextToastId = 0;

export function useToasts({ maxToasts = 3, duration = 2200 }: UseToastsOptions = {}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    toastsRef.current = toastsRef.current.filter((toast) => toast.id !== id);
    setToasts(toastsRef.current);
  }, []);

  const pushToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = `toast-${++nextToastId}`;
    const nextToast = { id, message, tone };
    const limit = Math.max(1, maxToasts);
    const nextToasts = [...toastsRef.current, nextToast].slice(-limit);
    const evictedIds = toastsRef.current
      .filter((toast) => !nextToasts.some((next) => next.id === toast.id))
      .map((toast) => toast.id);
    for (const evictedId of evictedIds) {
      const timer = timers.current.get(evictedId);
      if (timer) clearTimeout(timer);
      timers.current.delete(evictedId);
    }
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
    const timer = setTimeout(() => dismissToast(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismissToast, duration, maxToasts]);

  useEffect(() => {
    const limit = Math.max(1, maxToasts);
    if (toastsRef.current.length > limit) {
      const nextToasts = toastsRef.current.slice(-limit);
      const nextIds = new Set(nextToasts.map((toast) => toast.id));
      for (const toast of toastsRef.current) {
        if (!nextIds.has(toast.id)) {
          const timer = timers.current.get(toast.id);
          if (timer) clearTimeout(timer);
          timers.current.delete(toast.id);
        }
      }
      toastsRef.current = nextToasts;
      setToasts(nextToasts);
    }
  }, [maxToasts]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    toastsRef.current = [];
  }, []);

  return { toasts, pushToast, dismissToast };
}
