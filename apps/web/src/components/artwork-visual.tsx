import Image from "next/image";

export function ArtworkVisual({
  label,
  compact = false,
}: Readonly<{
  accent: readonly [string, string];
  label: string;
  compact?: boolean;
}>) {
  return (
    <div
      className={`artwork-visual${compact ? " artwork-visual--compact" : ""}`}
      role="img"
      aria-label={`Rights-cleared artwork area for ${label}`}
    >
      <Image
        alt=""
        className="artwork-visual__mark"
        height={180}
        src="/brand/artwork-a.svg"
        width={160}
      />
      <span className="artwork-visual__label">Rights-cleared artwork</span>
    </div>
  );
}
