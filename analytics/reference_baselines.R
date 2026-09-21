#!/usr/bin/env Rscript
# Offline: use frozen held-out inputs, never refit on the reference games.
root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
suppressPackageStartupMessages({ library(dplyr); library(tidyr); library(tibble) })
for (name in c("common", "states", "baselines", "rarity")) source(file.path(root, "R", paste0(name, ".R")))
directory <- file.path(root, "models"); evaluation <- jsonlite::read_json(file.path(directory, "evaluation.json"))
groups <- list(); sources <- list()
for (kind in c("fumble", "fg", "xp")) {
  entry <- evaluation$models[[kind]]; input <- file.path(directory, entry$inputSnapshot); model <- file.path(directory, paste0(kind, ".rds"))
  stopifnot(model_hash(model) == entry$checksum)
  data <- readRDS(input); artifact <- readRDS(model)
  data <- data[data$season %in% unlist(evaluation$splits$test), , drop = FALSE]
  predictions <- predict_baseline(artifact, data); stopifnot(all(is.finite(predictions)))
  data$residual <- (data$y - predictions) * if (kind == "fg") 3 else 1
  data$team <- if (kind == "fumble") data$fumbled_1_team else data$posteam
  label <- switch(kind, fumble = "Fumble recoveries above expectation", fg = "Field-goal points above expectation", xp = "Extra-point points above expectation")
  version <- paste0(BASELINE_VERSION, "-", substr(model_hash(model), 1, 12), if (kind == "fumble") "-team-recovery-v1" else "")
  template <- list(category = if (kind == "fumble") "fumble" else "kicking", name = label, unit = if (kind == "fumble") "recoveries" else "points", modelVersion = version)
  for (gid in unique(data$game_id)) {
    g <- data[data$game_id == gid, , drop = FALSE]
    if (kind == "fumble") {
      team <- g$home_team[[1]]
      value <- sum(ifelse(g$fumbled_1_team == team, g$residual, -g$residual))
      residuals <- c(value, -value)
    } else residuals <- tapply(g$residual, g$team, sum)
    key <- paste(rarity_key(template), opportunity_stratum(nrow(g)), sep = "|")
    groups[[key]][[gid]] <- list(gameId = gid, value = max(abs(residuals)))
  }
  sources[[kind]] <- list(input = basename(input), inputChecksum = model_hash(input), modelChecksum = model_hash(model), observations = nrow(data))
}
categories <- lapply(names(groups), function(key) reference_group(key, groups[[key]]))
write_json(list(schemaVersion = 1L, version = RARITY_VERSION, sources = sources, categories = categories,
  policy = "Fixed metric definitions; maximum absolute team residual per game; opportunity strata 1,2,3-4,5-8,9+; at least200 distinct games; at least5 observations in either empirical tail; whole percentiles. Only later seasons can be compared. No adjustment across categories or overall score.",
  overallPercentile = NULL, overallReason = "Overall aggregation and selection procedure has not been validated."), file.path(directory, "category-reference.json"))
message("Wrote offline category references: ", sum(vapply(categories, function(r) r$status == "eligible", logical(1))), " supported strata / ", length(categories))
