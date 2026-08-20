import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AssetDetail } from "@/components/asset-detail";
import { artworks, getArtwork } from "@/lib/catalog";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return artworks.map((artwork) => ({ slug: artwork.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const artwork = getArtwork((await params).slug);
  return { title: artwork ? `${artwork.title} fractionals` : "Fractionals" };
}

export default async function FractionalDetailPage({ params }: PageProps) {
  const artwork = getArtwork((await params).slug);
  if (!artwork) notFound();
  return <AssetDetail artwork={artwork} fractional />;
}
