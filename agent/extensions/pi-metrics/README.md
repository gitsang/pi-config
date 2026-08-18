# pi-metrics

Persistent local usage metrics for pi.

Records per day / month / all-time:
- tokens (input/output/cacheRead/cacheWrite) and cost
- prompt count and session count

Data is stored append-only in `events.jsonl` next to this extension and published to pi-statusline via `ext-status` keys such as `metrics-today-tokens`, `metrics-month-cost`, `metrics-total-tokens`.

## Usage

- `/metrics` — show today / month / total summary.

No configuration.
