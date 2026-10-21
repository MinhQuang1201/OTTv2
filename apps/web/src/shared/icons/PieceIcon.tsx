import { forwardRef, type SVGProps } from "react";
import { PixelSprite, type Seat } from "./PixelSprite";

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
  seat?: Seat;
}

export const PieceIcon = forwardRef<SVGSVGElement, PieceIconProps>(function PieceIcon(
  { type, title, decorative = false, seat, "aria-label": ariaLabel, width = 24, height = 24, ...props },
  ref,
) {
  const accessibleTitle = title ?? labels[type];
  return (
    <PixelSprite
      {...props}
      ref={ref}
      kind={type}
      seat={seat}
      title={accessibleTitle}
      aria-label={ariaLabel}
      decorative={decorative}
      width={width}
      height={height}
    />
  );
});
