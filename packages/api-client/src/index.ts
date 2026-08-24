import type { components } from "./schema";

export type ArtFiConfig = components["schemas"]["Config"];
export type Asset = components["schemas"]["Asset"];
export type MintedNFT = components["schemas"]["MintedNFT"];
export type Project = components["schemas"]["Project"];
export type Portfolio = components["schemas"]["Portfolio"];
export type Problem = components["schemas"]["Problem"];

export class ArtFiAPIError extends Error {
  constructor(public readonly problem: Problem) {
    super(problem.detail);
    this.name = "ArtFiAPIError";
  }
}

export function createArtFiClient(
  baseURL: string,
  fetcher: typeof fetch = fetch,
) {
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetcher(new URL(path, baseURL), {
      headers: { Accept: "application/json, application/problem+json" },
    });
    if (!response.ok) {
      throw new ArtFiAPIError((await response.json()) as Problem);
    }
    return (await response.json()) as T;
  };

  return {
    config: () => request<ArtFiConfig>("/v1/config"),
    assets: () => request<{ data: Asset[]; total: number }>("/v1/assets"),
    mintedNFTs: () =>
      request<{ data: MintedNFT[]; total: number; chainId: 84532 }>("/v1/nfts"),
    asset: (slug: string) =>
      request<Asset>(`/v1/assets/${encodeURIComponent(slug)}`),
    projects: () => request<{ data: Project[]; total: number }>("/v1/projects"),
    portfolio: (address: string) =>
      request<Portfolio>(`/v1/portfolio/${encodeURIComponent(address)}`),
  };
}
