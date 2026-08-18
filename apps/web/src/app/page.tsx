const stages = [
  [
    "01",
    "Connect",
    "Use an external wallet on Sepolia with clear transaction intent.",
  ],
  [
    "02",
    "Create",
    "Record provenance, upload metadata, and mint a verifiable RWA NFT.",
  ],
  [
    "03",
    "Fractionalize",
    "Deposit assets into a governed vault and issue fractional tokens.",
  ],
  [
    "04",
    "Govern",
    "Participate through transparent proposals, votes, bids, and claims.",
  ],
] as const;

export default function Home() {
  return (
    <main>
      <header className="nav-shell">
        <a className="brand" href="#top" aria-label="ArtFi home">
          <span className="brand-mark">A</span>
          <span>ArtFi</span>
        </a>
        <span className="network-pill">Sepolia · Stage 0</span>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Verified art infrastructure</p>
          <h1>Ownership with a provenance trail.</h1>
          <p className="lede">
            ArtFi is being rebuilt as an auditable platform for real-world art
            assets, vaults, fractional ownership, and DAO governance.
          </p>
          <div className="actions">
            <a className="primary" href="#roadmap">
              Explore the roadmap
            </a>
            <a
              className="secondary"
              href="https://github.com/GiraffeTechnology/ArtFi"
            >
              View repository
            </a>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orb orb-one" />
          <div className="orb orb-two" />
          <div className="artifact-card">
            <span>ARTFI / 0001</span>
            <strong>PROVENANCE</strong>
            <small>Asset identity · Custody · Governance</small>
          </div>
        </div>
      </section>

      <section className="roadmap" id="roadmap">
        <div className="section-heading">
          <p className="eyebrow">Core journey</p>
          <h2>Designed as a sequence of verifiable actions.</h2>
        </div>
        <div className="stage-grid">
          {stages.map(([number, title, description]) => (
            <article className="stage-card" key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="status-panel">
        <div>
          <p className="eyebrow">Release policy</p>
          <h2>Testnet first. Evidence before claims.</h2>
        </div>
        <p>
          Mainnet, real assets, and real-money operation remain disabled until
          contract audit, application security review, compliance approval, and
          controlled-launch gates pass.
        </p>
      </section>
    </main>
  );
}
