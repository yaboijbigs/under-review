# Game anomaly audit development evaluation

This evaluation runs the actual ingestion, analytics, game audit and immutable-report pipeline. It extends the [original controversy cohort](../controversy/README.md) with Green Bay's 20–17 overtime win at the Jets on September 20, 2026. Source and model hashes, exact audit outputs and target-play matches are preserved in `results.json`.

Read the [observed results](RESULTS.md) for the completed eight-game run and its limitations.

The Packers example and the earlier inspected plays motivated the uniform versioned rules. This is a development behavior check, not a held-out accuracy estimate or an independent validation of public perception. All games receive the same rules. No game IDs or team names are encoded into the audit logic. No manual reviews or social posts are created. Existing R model outputs remain distinct from the descriptive historical comparisons and review candidates.

## Packers source evidence

The [official gamebook](https://static.clubs.nfl.com/image/upload/packers/zu3fdftopjkj8hkcwckc), final team statistics on page 4, records GB 199 offensive yards, 14 penalties for 133 yards, and one giveaway versus no takeaways. NYJ recorded 285 yards and 13 penalties for 156 yards. The [Packers game notes](https://www.packers.com/news/game-notes-skyy-moore-s-heroics-ignite-packers-comeback-win-week-2-2026) describe the 63-yard punt return; the [Jets recap](https://www.newyorkjets.com/news/jets-packers-game-recap-week-2-09-20-2026) describes the overtime sacks and winning field goal. These observed mechanisms accompany the unusual outcome.

Our historical reference starts in 1999. It does not establish any claim about all NFL history or records since 1941. See [reference provenance, exclusions and exact reproduction](../../analytics/GAME_PROFILES.md).

## Run locally

Use the local setup in the root README, then:

```sh
docker build -f Dockerfile.worker -t under-review-worker:benchmark .
docker compose -f compose.yaml -f benchmarks/game-audit/compose.yaml run --rm --no-deps -T worker node --import tsx scripts/controversy-benchmark.ts /benchmark/cases.json /results
```

The benchmark runs sequentially on the development machine with one CPU and 2 GiB RAM, with live publishing disabled. It refuses to run on the shared VPS. Complete reports are saved to ignored `data/game-audit-benchmark`, and are available in the local application. Summary results published here exclude secrets, local snapshot paths and infrastructure details.
