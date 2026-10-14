import { forwardRef, type ButtonHTMLAttributes } from "react";
import { useTheme, type Theme } from "../theme/theme";
import { PixelSprite } from "../icons/PixelSprite";
import styles from "./ui.module.css";

export interface ThemeToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onChange"> {
  theme?: Theme;
  onToggle?: (nextTheme: Theme) => void;
  showLabel?: boolean;
}

export const ThemeToggle = forwardRef<HTMLButtonElement, ThemeToggleProps>(function ThemeToggle(
  { theme: propTheme, onToggle, showLabel = false, className, ...props },
  ref,
) {
  const themeContext = useTheme();
  const currentTheme = propTheme ?? themeContext.theme;
  const isDark = currentTheme === "dark";

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    props.onClick?.(e);
    if (e.defaultPrevented) return;
    const nextTheme: Theme = isDark ? "light" : "dark";
    if (onToggle) {
      onToggle(nextTheme);
    } else {
      themeContext.toggleTheme();
    }
  };

  const actionLabel = isDark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối";

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      className={[styles.themeToggle, className].filter(Boolean).join(" ")}
      onClick={handleClick}
      aria-label={props["aria-label"] ?? actionLabel}
      title={props.title ?? actionLabel}
      aria-pressed={isDark}
    >
      <PixelSprite
        kind={isDark ? "sun" : "moon"}
        size={18}
        decorative
        className={styles.themeToggleIcon}
      />
      {showLabel ? (
        <span className={styles.themeToggleText}>{isDark ? "Tối" : "Sáng"}</span>
      ) : null}
    </button>
  );
});
