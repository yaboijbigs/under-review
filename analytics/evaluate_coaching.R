#!/usr/bin/env Rscript
# Rscript analytics/evaluate_coaching.R [completed-era-season=2025] [current-season=2026]
# This is an observed-action diagnostic, not identification of unchosen counterfactual outcomes.
root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
suppressPackageStartupMessages({ library(dplyr); library(tidyr); library(tibble) })
for (name in c("common", "states", "fourth", "baselines")) source(file.path(root, "R", paste0(name, ".R")))
seasons <- as.integer(commandArgs(trailingOnly = TRUE)); if (!length(seasons)) seasons <- c(2025, 2026)
k35 <- fourth_kernel(root, 65L); k20 <- fourth_kernel(root, 80L)
reports <- list()
baseline_rates <- function(year) {
  d <- nflreadr::load_pbp(year)
  base <- d[which(d$down == 4 & d$qtr <= 4 & d$game_seconds_remaining > 15 & d$penalty == 0 & d$aborted_play == 0), ]
  go <- base[which(base$play_type %in% c("run", "pass")), ]
  fg <- base[which(base$field_goal_result %in% c("made", "missed")), ]
  list(season = year, go = mean(go$fourth_down_converted, na.rm = TRUE), fg = mean(fg$field_goal_result == "made"), nGo = nrow(go), nFg = nrow(fg))
}
for (season in seasons) {
  message("Fourth-down diagnostics: ", season)
  pbp <- nflreadr::load_pbp(season)
  candidates <- pbp[which(pbp$down == 4), , drop = FALSE]
  contexts <- list(); source_rows <- list(); reasons <- character()
  for (i in seq_len(nrow(candidates))) {
    p <- one_row(candidates, i)
    game <- list(id = txt(p$game_id), season = season, gameType = txt(p$season_type), homeTeam = txt(p$home_team), awayTeam = txt(p$away_team))
    ctx <- fourth_context(p, game)
    if (!is.null(ctx$reason)) { reasons <- c(reasons, ctx$reason); next }
    contexts[[length(contexts) + 1L]] <- ctx$data; source_rows[[length(source_rows) + 1L]] <- p
  }
  if (!length(contexts)) { reports[[as.character(season)]] <- list(eligible = nrow(candidates), modeled = 0L, status = "unavailable"); next }
  df <- bind_rows(contexts); rows <- rows_df(source_rows)
  current <- suppressWarnings(suppressMessages(k35$add_probs(df)))
  alternate <- suppressWarnings(suppressMessages(k20$add_probs(df)))
  chosen_go <- which(rows$play_type %in% c("run", "pass") & (!is.na(rows$fourth_down_converted) | !is.na(rows$fourth_down_failed)))
  chosen_fg <- which(rows$field_goal_result %in% c("made", "missed"))
  # Package probabilities evaluate only actually chosen actions; policy selection is not randomized.
  go_diag <- probability_diagnostics(as.integer(rows$fourth_down_converted[chosen_go] == 1), current$first_down_prob[chosen_go])
  fg_diag <- probability_diagnostics(as.integer(rows$field_goal_result[chosen_fg] == "made"), current$fg_make_prob[chosen_fg])
  constant <- baseline_rates(season - 1L)
  go_diag$priorSeasonConstant <- constant$go
  go_diag$constantBrier <- mean((as.integer(rows$fourth_down_converted[chosen_go] == 1) - constant$go)^2)
  fg_diag$priorSeasonConstant <- constant$fg
  fg_diag$constantBrier <- mean((as.integer(rows$field_goal_result[chosen_fg] == "made") - constant$fg)^2)
  values <- as.matrix(current[c("go_wp", "fg_wp", "punt_wp")]); alternative <- as.matrix(alternate[c("go_wp", "fg_wp", "punt_wp")])
  values[!is.finite(values)] <- -Inf; alternative[!is.finite(alternative)] <- -Inf
  finite <- rowSums(is.finite(values)) >= 2 & rowSums(is.finite(alternative)) >= 2
  recommendations_changed <- sum(max.col(values[finite, , drop = FALSE], ties.method = "first") != max.col(alternative[finite, , drop = FALSE], ties.method = "first"))
  reports[[as.character(season)]] <- list(eligible = nrow(candidates), modeled = nrow(current), games = length(unique(rows$game_id)),
    exclusionReasons = as.list(table(reasons)), go = go_diag, fieldGoal = fg_diag, kickoffSensitivityChangedActionCount = recommendations_changed,
    finiteActionCoverage = sum(finite), sourceChecksum = digest::digest(pbp, algo = "sha256"),
    status = if (all(finite) && length(unique(rows$game_id)) >= 10 && length(chosen_go) >= 30 && length(chosen_fg) >= 30) "diagnostics_completed" else "insufficient_current_era_coverage")
}
test_path <- file.path(root, "models/test-evidence.json")
tests <- if (file.exists(test_path)) jsonlite::read_json(test_path) else list()
checks <- list(
  parity = isTRUE(tests$parityPassed), transitions = isTRUE(tests$ruleTransitionTestsPassed), predecisionOnly = isTRUE(tests$predecisionOnlyPassed),
  currentAdapterTested = identical(tests$adapterChecksum, model_hash(file.path(root, "R/fourth.R"))),
  currentStatesTested = identical(tests$statesChecksum, model_hash(file.path(root, "R/states.R"))))
prior <- reports[["2025"]]; current <- reports[["2026"]]
checks$priorSample <- !is.null(prior) && prior$go$n >= 500 && prior$fieldGoal$n >= 500
checks$priorGoBrier <- !is.null(prior) && prior$go$brier <= prior$go$constantBrier + .005
checks$priorFgBrier <- !is.null(prior) && prior$fieldGoal$brier <= prior$fieldGoal$constantBrier + .005
checks$currentCoverage <- !is.null(current) && current$games >= 10 && current$go$n >= 30 && current$fieldGoal$n >= 30 && current$finiteActionCoverage == current$modeled
empirical_path <- file.path(root, "models/kickoff_starts.rds")
empirical <- if (file.exists(empirical_path)) readRDS(empirical_path) else data.frame(season = integer())
checks$empiricalPriorCoverage <- sum(empirical$season == 2025) >= 100
failures <- names(checks)[!unlist(checks)]
report <- list(schemaVersion = 1L, version = FOURTH_VERSION, seasons = reports,
  gate = list(version = "2026-observed-action-gate-v1", checks = checks, passed = !length(failures), failures = as.list(failures),
    adapterChecksum = model_hash(file.path(root, "R/fourth.R")), statesChecksum = model_hash(file.path(root, "R/states.R")),
    empiricalChecksum = if (file.exists(empirical_path)) model_hash(empirical_path) else NULL,
    policy = "Parity/state/predecision tests; 2025 >=500 go and FG observations, each Brier no worse than previous-season constant +0.005; 2026 >=10 games, >=30 go/FG, all modeled rows finite; >=100 prior2025 ordinary kickoff starts.",
    statisticalValidation = "observed_action_diagnostics_only", upstreamProvenance = "training_cutoff_unknown",
    releaseStatus = if (!length(failures)) "supported_model_relative_estimates_for_insensitive_domain" else "experimental_gate_failed",
    reason = "Promotion is model-relative within the tested domain; it does not establish causal counterfactual accuracy or eliminate unknown upstream training provenance."),
  limitations = as.list(c("No counterfactual validation of unchosen actions.", "Upstream artifact training provenance cannot prove leakage-free evaluation.", "Penalty/aborted/fake situations and overtime excluded; observed-action selection bias remains.", "Kickoff sensitivity compares valid simplified branches, not confidence intervals.")))
write_json(report, file.path(root, "models/coaching-evaluation.json"))
