import { useId, type SVGProps } from "react";

export type PieceType = "dam" | "la" | "keo";

const labels: Record<PieceType, string> = {
  dam: "Đấm",
  la: "Lá",
  keo: "Kéo",
};

export interface PieceIconProps extends Omit<SVGProps<SVGSVGElement>, "title"> {
  type: PieceType;
  title?: string;
  decorative?: boolean;
}
export function PieceIcon({ type, title, decorative = false, ...props }: PieceIconProps) {
  const titleId = useId();
  const accessibleTitle = title ?? labels[type];
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      width={props.width ?? 24}
      height={props.height ?? 24}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? "true" : undefined}
      aria-labelledby={decorative ? undefined : titleId}
      focusable="false"
    >
      {!decorative ? <title id={titleId}>{accessibleTitle}</title> : null}
      {type === "dam" ? (
        <>
          <circle cx="12" cy="12" r="9" fill="currentColor" opacity=".16" />
          <path d="M7 8.5h10M7 12h10M7 15.5h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : null}
      {type === "la" ? (
        <path d="M12 21C8.1 18.8 5 15.4 5 11.3 5 7.7 7.6 5 12 3c4.4 2 7 4.7 7 8.3 0 4.1-3.1 7.5-7 9.7Z" fill="currentColor" opacity=".2" stroke="currentColor" strokeWidth="1.7" />
      ) : null}
      {type === "keo" ? (
        <>
          <path d="M12 21V8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="m12 8-4.2-4M12 8l4.2-4M12 13l-4.2-2.8M12 13l4.2-2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.8 21h6.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
}
