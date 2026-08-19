import { RwaCreateFlow } from "@/components/rwa-create-flow";

export default function CreateRwaPage() {
  return (
    <main className="page-shell page-main">
      <header className="page-intro page-intro--compact">
        <p className="eyebrow">Stage 2 · authorized testnet write</p>
        <h1>Commit the record before the token.</h1>
        <p>
          Upload a rights-cleared test image, review the immutable metadata
          commitment, and ask an authorized external wallet to mint on Sepolia.
          The application never receives a private key.
        </p>
      </header>
      <RwaCreateFlow />
    </main>
  );
}
