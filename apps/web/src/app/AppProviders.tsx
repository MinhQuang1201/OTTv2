import { createContext, useContext, useMemo, type PropsWithChildren } from "react";
import { ToastRegion } from "../shared/ui/ToastRegion";
import { useToasts, type Toast, type ToastTone } from "../shared/ui/useToasts";

export interface ToastControls {
  readonly toasts: Toast[];
  readonly pushToast: (message: string, tone?: ToastTone) => string;
  readonly dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastControls | null>(null);

export function useAppToasts(): ToastControls {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useAppToasts must be used inside AppProviders");
  return value;
}

export function AppProviders({ children }: PropsWithChildren) {
  const toastControls = useToasts();
  const value = useMemo<ToastControls>(() => toastControls, [toastControls]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={value.toasts} onDismiss={value.dismissToast} />
    </ToastContext.Provider>
  );
}
