const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 300_000;
const STABLE_MS = 120_000;

function retryDelayMs(attempt, random = Math.random) {
    const base = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** Math.min(attempt, 6));
    const low = Math.max(MIN_DELAY_MS, base * 0.8);
    const high = Math.min(MAX_DELAY_MS, base * 1.2);
    return Math.round(low + (high - low) * random());
}

module.exports = { retryDelayMs, STABLE_MS };
