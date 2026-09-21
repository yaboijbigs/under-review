#!/usr/bin/env Rscript
# Rscript analytics/train.R [train_start=2015] [train_end=2022] [calibration=2023] [test_start=2024] [test_end=2025]
root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
suppressPackageStartupMessages({ library(dplyr); library(tidyr); library(tibble) })
for (name in c("common", "states", "baselines")) source(file.path(root, "R", paste0(name, ".R")))
args <- as.integer(commandArgs(trailingOnly = TRUE)); defaults <- c(2015L, 2022L, 2023L, 2024L, 2025L); defaults[seq_along(args)] <- args
stopifnot(length(defaults) == 5, defaults[[1]] <= defaults[[2]], defaults[[2]] < defaults[[3]], defaults[[3]] < defaults[[4]], defaults[[4]] <= defaults[[5]])
seasons <- c(seq(defaults[[1]], defaults[[2]]), defaults[[3]], seq(defaults[[4]], defaults[[5]]))
set.seed(20260921); options(nflreadr.verbose = FALSE)
all <- list(); starts <- list(); sources <- list()
for (season in seasons) {
  message("Loading historical season ", season)
  raw <- nflreadr::load_pbp(season)
  sources[[as.character(season)]] <- list(season = season, url = paste0("https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_", season, ".rds"), rows = nrow(raw), checksum = digest::digest(raw, algo = "sha256"))
  raw <- baseline_features(raw)
  # Prior-only kickoff return start sensitivity; no outcome data from target game.
  for (gid in unique(raw$game_id)) {
    g <- raw[raw$game_id == gid, , drop = FALSE]
    kicks <- which(g$kickoff_attempt == 1 & g$touchdown == 0 & g$penalty == 0 & g$own_kickoff_recovery == 0 & !grepl("onside", g$desc, ignore.case = TRUE))
    for (i in kicks) if (i < nrow(g)) {
      nxt <- which(seq_len(nrow(g)) > i & g$play_type %in% c("pass", "run", "qb_kneel", "qb_spike"))
      if (length(nxt) && nxt[[1]] - i <= 3 && g$qtr[[i]] == g$qtr[[nxt[[1]]]]) starts[[length(starts) + 1L]] <- data.frame(game_id = gid, season = season, yardline_100 = g$yardline_100[[nxt[[1]]]])
    }
  }
  # Keep only predictor and target datasets, not every raw season in memory.
  all[[as.character(season)]] <- list(fumble = fumble_rows(raw), fg = kick_rows(raw), xp = kick_rows(raw, TRUE), penalty = penalty_game_rows(raw))
  rm(raw); gc(FALSE)
}
dir.create(file.path(root, "models"), recursive = TRUE, showWarnings = FALSE)
report <- list(schemaVersion = 1L, version = BASELINE_VERSION, sources = sources, splits = list(train = seq(defaults[[1]], defaults[[2]]), calibration = defaults[[3]], test = seq(defaults[[4]], defaults[[5]])), models = list())
for (kind in c("fumble", "fg", "xp", "penalty")) {
  data <- bind_rows(lapply(all, `[[`, kind))
  if (kind == "penalty") data <- add_prior_rates(data)
  artifact <- fit_baseline(kind, data[data$season <= defaults[[2]], ], data[data$season == defaults[[3]], ], data[data$season >= defaults[[4]] & data$season <= defaults[[5]], ])
  if (kind == "penalty") artifact$history <- data[data$season <= defaults[[3]], ]
  path <- file.path(root, "models", paste0(kind, ".rds")); saveRDS(artifact, path, version = 3)
  report$models[[kind]] <- list(checksum = model_hash(path), diagnostics = artifact$diagnostics, trainingSeasons = artifact$trainingSeasons, calibrationSeasons = artifact$calibrationSeasons, testSeasons = artifact$testSeasons)
  # Compact derived input snapshot permits identical retraining without mutable remote releases.
  input_hash <- digest::digest(data, algo = "sha256")
  input_path <- file.path(root, "models", paste0("training-input-", kind, "-", input_hash, ".rds"))
  if (!file.exists(input_path)) saveRDS(data, input_path, version = 3)
  report$models[[kind]]$inputSnapshot <- basename(input_path)
}
saveRDS(bind_rows(starts), file.path(root, "models/kickoff_starts.rds"), version = 3)
write_json(report, file.path(root, "models/evaluation.json"))
message("Saved chronological models and held-out evaluation to ", file.path(root, "models"))
