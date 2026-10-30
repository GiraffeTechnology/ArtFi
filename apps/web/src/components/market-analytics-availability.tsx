const analytics = [
  ["Price history", "Unavailable from an attributed runtime source."],
  ["Holder distribution", "Unavailable from an attributed runtime source."],
  ["Transaction analytics", "Unavailable from an attributed runtime source."],
] as const;

export function MarketAnalyticsAvailability() {
  return (
    <section
      className="record-grid"
      aria-labelledby="market-analytics-title"
      aria-describedby="market-analytics-description"
    >
      <article>
        <p className="eyebrow">Market analytics</p>
        <h2 id="market-analytics-title">Runtime analytics are unavailable</h2>
        <p id="market-analytics-description">
          This detail page does not have an attributed runtime price series,
          holder snapshot, or transaction-analytics dataset. Catalogue figures
          above are prototype data and must not be read as current market state.
          No fixture, estimate, or historical snapshot is presented as live.
        </p>
        <dl className="asset-metrics">
          {analytics.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </article>
    </section>
  );
}
