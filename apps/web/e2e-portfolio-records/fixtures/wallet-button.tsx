import { useConnect } from "wagmi";
export function WalletButton() {
  const { connectAsync, connectors, isPending } = useConnect();
  const initialChain =
    new URLSearchParams(location.search).get("network") === "1"
      ? 1
      : new URLSearchParams(location.search).get("network") === "8453"
        ? 8453
        : 560048;
  return (
    <button
      disabled={isPending}
      onClick={() =>
        void connectAsync({ connector: connectors[0], chainId: initialChain })
      }
    >
      Connect TEST_ONLY wallet
    </button>
  );
}
