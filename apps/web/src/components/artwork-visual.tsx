import type { CSSProperties } from "react";

export function ArtworkVisual({
  accent,
  label,
  compact = false,
}: Readonly<{
  accent: readonly [string, string];
  label: string;
  compact?: boolean;
}>) {
  const style = {
    "--visual-a": accent[0],
    "--visual-b": accent[1],
  } as CSSProperties;

  return (
    <div
      className={`artwork-visual${compact ? " artwork-visual--compact" : ""}`}
      style={style}
      role="img"
      aria-label={`Original abstract placeholder for ${label}`}
    >
      <span className="visual-plane visual-plane--one" />
      <span className="visual-plane visual-plane--two" />
      <span className="visual-grain" />
    </div>
  );
}
