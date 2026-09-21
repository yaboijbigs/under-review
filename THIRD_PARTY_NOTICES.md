# Attribution and separate licenses

The MIT license at the repository root applies to original application code. It does not relicense third-party data, model artifacts, dependencies, or vendored code.

- **nflverse / nflfastR:** selected play-by-play fixtures and transformed historical model inputs originate from nflverse data under CC BY 4.0. Schedules additionally credit Lee Sharpe. Source URLs, access dates, checksums and transformations are recorded in `DATA_SOURCES.md`, fixture manifests and `analytics/models/evaluation.json`.
- **FTN Data via nflverse:** extracted FTN fixtures and FTN-derived charting data retain CC BY-SA 4.0, attribution and transformation notices. Original independent application code is separately licensed. FTN data is not used to train the bundled fumble or kicking baselines.
- **nfl4th:** the vendored upstream code retains its original MIT notices in `analytics/vendor/nfl4th`. The Under Review adapter is documented separately; adapted results must not be represented as unmodified upstream results.
- **nflfastR, nflreadr, fastrmodels and other dependencies:** retain their upstream licenses and authorship. Frozen model provenance is recorded in `analytics/models/manifest.json`; the R and npm dependency locks identify exact software versions. Dependency licenses remain in their installed distributions within container images.

Data licenses: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Consult [DATA_SOURCES.md](DATA_SOURCES.md) for specific upstream notices and limitations. This project does not distribute league/team logos, game footage, or the NFL rulebook and is not affiliated with the NFL.
