import { useCallback, useRef, useState } from "react";

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
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = `toast-${++nextToastId}`;
    setToasts((current) => [...current, { id, message, tone }].slice(-Math.max(1, maxToasts)));
    const timer = setTimeout(() => dismissToast(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismissToast, duration, maxToasts]);

  return { toasts, pushToast, dismissToast };
}
