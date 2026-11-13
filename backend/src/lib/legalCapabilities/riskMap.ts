/**
 * Unified risk band used by the <RiskBadge> component. Each capability
 * keeps its native risk vocabulary internally (faithful to its source
 * Anthropic skill) and emits a {scheme, ...} payload that this module
 * folds into one of four bands so the UI shows consistent badges.
 *
 * - low: GREEN / aligned / unlikely+low / low risk area / score <= 4
 * - medium: YELLOW / minor deviation / possible+medium / medium risk / score 5-9
 * - high: RED / material deviation / probable+high / high risk / score 10-15
 * - critical: deal-breaker / almost-certain+critical / score >= 16
 */

export type UnifiedRiskBand = "low" | "medium" | "high" | "critical";

export type RiskInput =
    | { scheme: "traffic-light"; value: "GREEN" | "YELLOW" | "RED" }
    | {
          scheme: "severity-likelihood";
          severity: "Low" | "Medium" | "High" | "Critical";
          likelihood:
              | "Unlikely"
              | "Possible"
              | "Probable"
              | "Almost Certain";
      }
    | {
          scheme: "deviation";
          value: "aligned" | "minor" | "material" | "deal-breaker";
      }
    | { scheme: "risk-area"; value: "low" | "medium" | "high" }
    | { scheme: "risk-score"; score: number };

export function toUnifiedBand(input: RiskInput): UnifiedRiskBand {
    switch (input.scheme) {
        case "traffic-light": {
            if (input.value === "GREEN") return "low";
            if (input.value === "YELLOW") return "medium";
            if (input.value === "RED") return "high";
            return "medium";
        }
        case "severity-likelihood": {
            // Severity dominates; only "Almost Certain" likelihood escalates
            // the band by one. Matches the legal-risk-assessment skill's
            // escalation thresholds — being plausible doesn't bump the band,
            // being near-inevitable does.
            const sev = { Low: 0, Medium: 1, High: 2, Critical: 3 }[
                input.severity
            ];
            const lik = {
                Unlikely: 0,
                Possible: 0,
                Probable: 0,
                "Almost Certain": 1,
            }[input.likelihood];
            const score = Math.min(3, sev + lik);
            return (["low", "medium", "high", "critical"] as const)[score];
        }
        case "deviation": {
            const map = {
                aligned: "low",
                minor: "medium",
                material: "high",
                "deal-breaker": "critical",
            } as const;
            return map[input.value];
        }
        case "risk-area": {
            return input.value;
        }
        case "risk-score": {
            // Guard non-finite first: -Infinity would otherwise band as
            // "low" and Infinity as "critical", both of which read as a
            // confident answer the model never actually gave.
            if (!Number.isFinite(input.score)) return "medium";
            if (input.score <= 4) return "low";
            if (input.score <= 9) return "medium";
            if (input.score <= 15) return "high";
            return "critical";
        }
        default: {
            return "medium";
        }
    }
}
