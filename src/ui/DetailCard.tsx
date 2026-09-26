import type { Company, Hit } from '../types'
import { fmtMoney } from '../search/parse'

function fmtNum(n: number | null): string {
  if (n == null) return 'N/A'
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n)
}

function Metric({ label, value, estimated }: { label: string; value: string; estimated?: boolean }) {
  const na = value === 'N/A'
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={'metric-value' + (na ? ' is-na' : '')}>
        {value}
        {estimated && !na && <em className="est" title="Estimated — not a reported figure">est</em>}
      </span>
    </div>
  )
}

export function DetailCard({
  company,
  hit,
  onClose,
  onCompetitors,
}: {
  company: Company
  hit: Hit | undefined
  onClose: () => void
  onCompetitors: (c: Company) => void
}) {
  return (
    <aside className="detail" role="dialog" aria-label={company.name}>
      <button className="detail-close" onClick={onClose} aria-label="Close">×</button>

      <header className="detail-head">
        <img
          className="detail-logo"
          src={company.logo}
          alt=""
          referrerPolicy="no-referrer"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = company.logoFallback }}
        />
        <div>
          <h2>{company.name}</h2>
          <a className="detail-domain" href={`https://${company.domain}`} target="_blank" rel="noreferrer noopener">
            {company.domain} ↗
          </a>
        </div>
        {hit && <div className="detail-conf" title="Relevance to your query">{hit.confidence}%</div>}
      </header>

      <p className="detail-desc">{company.description}</p>

      {hit && hit.reasons.length > 0 && (
        <div className="detail-why">
          <h3>Why it matched</h3>
          <ul>{hit.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <div className="metrics">
        <Metric
          label={company.revenueFiscalYear ? `Revenue FY${String(company.revenueFiscalYear).slice(2)}` : 'Revenue'}
          value={company.revenueUsd ? fmtMoney(company.revenueUsd) : 'N/A'}
          estimated={company.revenueEstimated}
        />
        <Metric label="Valuation" value={company.valuationUsd ? fmtMoney(company.valuationUsd) : 'N/A'} estimated={company.valuationEstimated} />
        <Metric label="Employees" value={fmtNum(company.employees)} />
        <Metric label="Founded" value={company.founded ? String(company.founded) : 'N/A'} />
        <Metric label="Funding" value={company.fundingTotalUsd ? fmtMoney(company.fundingTotalUsd) : 'N/A'} />
        <Metric
          label="Stage"
          value={company.stage === 'unknown' ? 'N/A' : company.ticker ? `${company.stage} · ${company.ticker}` : company.stage}
        />
      </div>

      <div className="detail-meta">
        <span>📍 {[company.hqCity, company.hqCountry].filter((x) => x && x !== 'Unknown').join(', ') || 'HQ unknown'}</span>
        {company.isUnicorn && <span className="unicorn">🦄 unicorn</span>}
      </div>

      <div className="chips">
        {company.categories.map((c) => <span className="chip chip-cat" key={c}>{c}</span>)}
      </div>

      <button className="detail-action" onClick={() => onCompetitors(company)}>
        Find competitors of {company.name}
      </button>
    </aside>
  )
}
