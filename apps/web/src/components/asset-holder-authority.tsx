/**
 * Who the holder authority is, for a whole artwork — #110 §2, `PRD.md` §1.0.5.
 *
 * The client ruled on 2026-09-19 that for a registry-backed asset the **registry of record** is the
 * holder authority, the on-chain token is its projection, and ArtFi's own stores are authoritative
 * for nothing. Three records, three standings. Until now that ruling existed only in documents —
 * and an asset page is exactly where a reader decides what they believe about who owns a thing.
 *
 * The honest part is the third column. ArtFi consumes registries and operates none of them, and no
 * registry of record is connected in this build, so the authority row says so rather than showing a
 * holder this application cannot attest. A page that filled that row from its own database would be
 * asserting precisely the thing §1.0.5 says ArtFi never asserts.
 */

const records = [
  {
    record: "Registry of record",
    standing: "Authority for holdership",
    here: "Not connected in this build. No holder is shown from it.",
  },
  {
    record: "Chain",
    standing: "Projection of the registry, and the settlement record",
    here: "Read where a token address is configured; otherwise not read.",
  },
  {
    record: "ArtFi's own store",
    standing: "Read-only projection. Authoritative for nothing.",
    here: "Never the source of a holder claim on this page.",
  },
] as const;

export function AssetHolderAuthority({ className }: { className?: string }) {
  return (
    <section
      aria-label="Holder authority"
      className={className ?? "holder-authority"}
      data-testid="asset-holder-authority"
    >
      <h2>Who says who holds it</h2>
      <p>
        For a registry-backed artwork the registry of record is the holder
        authority, and the on-chain token is its projection. ArtFi is a consumer
        of registries and operates none of them.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Standing</th>
            <th scope="col">In this build</th>
          </tr>
        </thead>
        <tbody>
          {records.map((row) => (
            <tr key={row.record}>
              <th scope="row">{row.record}</th>
              <td>{row.standing}</td>
              <td>{row.here}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="market-gate">
        Where the registry and the chain disagree, ArtFi reports the divergence.
        It never resolves one by asserting its own projection.
      </p>
    </section>
  );
}
