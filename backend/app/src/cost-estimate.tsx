import { Info } from "lucide-react";

export function CostEstimate({ hourly, currency = "USD" }: { hourly: number; currency?: string }) {
  const format = (value: number) => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
  const estimates = [
    { label: "Hour", value: format(hourly) },
    { label: "Day", value: format(hourly * 24) },
    { label: "Month", value: format(hourly * 730) },
  ];
  const description = estimates.map((estimate) => `${estimate.value} per ${estimate.label.toLowerCase()}`).join(", ");

  return (
    <span className="cost-estimate">
      <span>{format(hourly)}/hr</span>
      <span className="cost-tooltip" tabIndex={0} aria-label={`Cost estimates: ${description}`}>
        <Info size={14} aria-hidden="true" />
        <span className="cost-tooltip-panel" role="tooltip">
          {estimates.map((estimate) => (
            <span key={estimate.label}><small>{estimate.label}</small><strong>{estimate.value}</strong></span>
          ))}
        </span>
      </span>
    </span>
  );
}

export function CentsCostEstimate({ hourlyCents }: { hourlyCents: number }) {
  return <CostEstimate hourly={hourlyCents / 100} currency="USD" />;
}
