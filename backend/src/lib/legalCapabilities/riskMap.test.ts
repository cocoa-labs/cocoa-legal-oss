// backend/src/lib/legalCapabilities/riskMap.test.ts
import assert from "node:assert/strict";
import { toUnifiedBand, type UnifiedRiskBand } from "./riskMap";

async function testTrafficLight() {
    assert.equal(
        toUnifiedBand({ scheme: "traffic-light", value: "GREEN" }),
        "low",
    );
    assert.equal(
        toUnifiedBand({ scheme: "traffic-light", value: "YELLOW" }),
        "medium",
    );
    assert.equal(
        toUnifiedBand({ scheme: "traffic-light", value: "RED" }),
        "high",
    );
}

async function testSeverityLikelihood() {
    // 5x5 grid: severity × likelihood
    assert.equal(
        toUnifiedBand({
            scheme: "severity-likelihood",
            severity: "Low",
            likelihood: "Unlikely",
        }),
        "low",
    );
    assert.equal(
        toUnifiedBand({
            scheme: "severity-likelihood",
            severity: "Medium",
            likelihood: "Possible",
        }),
        "medium",
    );
    assert.equal(
        toUnifiedBand({
            scheme: "severity-likelihood",
            severity: "High",
            likelihood: "Probable",
        }),
        "high",
    );
    assert.equal(
        toUnifiedBand({
            scheme: "severity-likelihood",
            severity: "Critical",
            likelihood: "Almost Certain",
        }),
        "critical",
    );
}

async function testDeviation() {
    assert.equal(
        toUnifiedBand({ scheme: "deviation", value: "aligned" }),
        "low",
    );
    assert.equal(
        toUnifiedBand({ scheme: "deviation", value: "minor" }),
        "medium",
    );
    assert.equal(
        toUnifiedBand({ scheme: "deviation", value: "material" }),
        "high",
    );
    assert.equal(
        toUnifiedBand({ scheme: "deviation", value: "deal-breaker" }),
        "critical",
    );
}

async function testRiskArea() {
    assert.equal(
        toUnifiedBand({ scheme: "risk-area", value: "low" }),
        "low",
    );
    assert.equal(
        toUnifiedBand({ scheme: "risk-area", value: "medium" }),
        "medium",
    );
    assert.equal(
        toUnifiedBand({ scheme: "risk-area", value: "high" }),
        "high",
    );
}

async function testRiskScore() {
    // Band boundaries: <=4 low, <=9 medium, <=15 high, else critical.
    assert.equal(toUnifiedBand({ scheme: "risk-score", score: 4 }), "low");
    assert.equal(toUnifiedBand({ scheme: "risk-score", score: 5 }), "medium");
    assert.equal(toUnifiedBand({ scheme: "risk-score", score: 9 }), "medium");
    assert.equal(toUnifiedBand({ scheme: "risk-score", score: 10 }), "high");
    assert.equal(toUnifiedBand({ scheme: "risk-score", score: 15 }), "high");
    assert.equal(
        toUnifiedBand({ scheme: "risk-score", score: 16 }),
        "critical",
    );
    assert.equal(
        toUnifiedBand({ scheme: "risk-score", score: 25 }),
        "critical",
    );
}

async function testRiskScoreNonFiniteReturnsMedium() {
    // A model that emits a garbage score must not be silently banded as
    // "low" (-Infinity) or "critical" (Infinity) — degrade to medium.
    assert.equal(
        toUnifiedBand({ scheme: "risk-score", score: Number.NaN }),
        "medium",
    );
    assert.equal(
        toUnifiedBand({ scheme: "risk-score", score: Number.POSITIVE_INFINITY }),
        "medium",
    );
    assert.equal(
        toUnifiedBand({ scheme: "risk-score", score: Number.NEGATIVE_INFINITY }),
        "medium",
    );
}

async function testUnknownReturnsMedium() {
    // Unknown inputs degrade to medium so the UI still shows something
    // useful rather than crashing or hiding the badge entirely.
    const band: UnifiedRiskBand = toUnifiedBand({
        scheme: "traffic-light",
        value: "FUCHSIA" as never,
    });
    assert.equal(band, "medium");
}

async function main() {
    await testTrafficLight();
    await testSeverityLikelihood();
    await testDeviation();
    await testRiskArea();
    await testRiskScore();
    await testRiskScoreNonFiniteReturnsMedium();
    await testUnknownReturnsMedium();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
