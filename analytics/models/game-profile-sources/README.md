# Frozen source snapshots

These gzip archives contain original public nflverse CSV bytes, named by the uncompressed SHA-256. `../game-profiles.json` maps each archive to its exact URL, retrieval time, HTTP metadata and data license. `../../build-game-profiles.mjs` verifies the original bytes before rebuilding the reference offline.

Data attribution: **nflverse / nflfastR**, schedules additionally **Lee Sharpe**. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as published in the [nflverse-data data license](https://raw.githubusercontent.com/nflverse/nflverse-data/main/LICENSE.md). These archives are compressed original data; transformations to the generated reference are documented in `../../GAME_PROFILES.md`. The software MIT license does not replace the data license.
