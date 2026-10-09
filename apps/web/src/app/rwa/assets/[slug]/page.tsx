import { RwaAssetDetail } from "@/components/rwa-asset-detail";
import { notFound } from "next/navigation";
import { rwaSlugSchema } from "@/lib/rwa-catalog";
export default async function SourceAssetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!rwaSlugSchema.safeParse(slug).success) notFound();
  return <RwaAssetDetail slug={slug} section="whole" />;
}
