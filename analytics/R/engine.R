analyze_game <- function(request, root) {
  game <- request$game; plays <- rows_df(request$plays)
  require_columns(plays, c("play_id", "desc", "qtr"))
  if (anyDuplicated(as.character(plays$play_id))) stop("Duplicate play IDs: ingestion must reconcile revisions before analysis")
  # Preserve provider order. Replay/no-play rows remain present.
  metrics <- events <- timeline <- list(); warnings <- character()
  model_dir <- request$config$modelDirectory %||% file.path(root, "models")
  states <- lapply(seq_len(nrow(plays)), function(i) state_from_play(one_row(plays, i), game))
  good <- which(vapply(states, function(s) is.null(state_reason(s)), logical(1)))
  wp <- rep(NA_real_, nrow(plays))
  if (length(good)) {
    pred <- safe_model(nflfastR::calculate_win_probability(dplyr::bind_rows(states[good])))
    if ("error" %in% names(pred)) warnings <- c(warnings, "State WP model failed; timeline is unavailable.") else {
      wp[good] <- ifelse(pred$posteam == game$homeTeam, pred$wp, 1 - pred$wp)
    }
  }
  kernels <- safe_model(list(standard_own35 = fourth_kernel(root, 65L), touchback_own20 = fourth_kernel(root, 80L)))
  if (num(game$season) == 2024 && is.null(kernels$error)) kernels <- list(standard_own30 = fourth_kernel(root, 70L), touchback_own20 = kernels$touchback_own20)
  if (num(game$season) < 2024 && is.null(kernels$error)) kernels <- list(legacy_own25 = fourth_kernel(root, 75L), touchback_own20 = kernels$touchback_own20)
  empirical_path <- file.path(model_dir, "kickoff_starts.rds")
  if (file.exists(empirical_path) && is.null(kernels$error)) {
    prior <- readRDS(empirical_path); prior <- prior[prior$game_id < game$id & prior$season >= max(game$season - 2, if (game$season >= 2025) 2025 else 2016), , drop = FALSE]
    if (nrow(prior) >= 100) {
      # Discrete empirical quantiles approximate the prior-only distribution; all three scenarios are shown.
      spots <- unique(as.integer(round(quantile(prior$yardline_100, probs = c(.25, .5, .75), names = FALSE))))
      for (spot in spots) kernels[[paste0("prior_return_start_", 100 - spot)]] <- fourth_kernel(root, spot)
    } else warnings <- c(warnings, "Fewer than 100 prior-era ordinary return starts: empirical kickoff sensitivity unavailable.")
  } else warnings <- c(warnings, "Empirical kickoff continuation sensitivity is unavailable until historical training runs.")
  promotion <- list(passed = FALSE, reason = "validation_gate_unavailable")
  evaluation_path <- file.path(root, "models/coaching-evaluation.json")
  if (file.exists(evaluation_path)) {
    gate <- jsonlite::read_json(evaluation_path)$gate
    current <- isTRUE(gate$passed) && identical(gate$adapterChecksum, model_hash(file.path(root, "R/fourth.R"))) &&
      identical(gate$statesChecksum, model_hash(file.path(root, "R/states.R"))) && file.exists(empirical_path) && identical(gate$empiricalChecksum, model_hash(empirical_path))
    promotion <- list(passed = current, reason = if (current) NULL else paste0("validation_gate_failed_or_stale:", paste(unlist(gate$failures), collapse = ",")))
  }
  for (i in seq_len(nrow(plays))) {
    p <- one_row(plays, i); id <- event_id(game$id, p)
    # Timeline outputs are model estimates only in supported regulation scrimmage states.
    timeline[[length(timeline) + 1L]] <- list(playId = txt(p$play_id), quarter = if (is.finite(num(p$qtr))) num(p$qtr) else NULL,
      clock = if (is.na(scalar(p$time, NA))) NULL else txt(p$time), homeWp = if (is.finite(wp[[i]])) wp[[i]] else NULL, description = txt(p$desc))
    relevant <- flag(p$penalty) || length(parse_penalties(p$desc)) || num(p$down, 0) == 4 || flag(p$fumble) || flag(p$field_goal_attempt) || flag(p$extra_point_attempt)
    if (relevant) events[[length(events) + 1L]] <- list(id = id, playId = txt(p$play_id), quarter = if (is.finite(num(p$qtr))) num(p$qtr) else NULL, clock = if (is.na(scalar(p$time, NA))) NULL else txt(p$time), description = txt(p$desc), kind = if (flag(p$penalty)) "penalty" else if (flag(p$fumble)) "fumble" else if (flag(p$field_goal_attempt) || flag(p$extra_point_attempt)) "kick" else "fourth_down", team = if (nzchar(txt(p$posteam))) txt(p$posteam) else NULL, reviewStatus = "not_reviewed")
    if (flag(p$penalty) || length(parse_penalties(p$desc))) {
      pair <- penalty_states(p, if (i < nrow(plays)) one_row(plays, i + 1L) else NULL, game)
      if (!is.null(pair$reason)) {
        metrics[[length(metrics) + 1L]] <- metric(paste0(id, ":ruling"), "officiating", "Observed ruling consequence", txt(p$posteam), unit = "wp_delta", status = "unavailable", reason = pair$reason, event = id, play = p$play_id, model = WP_VERSION, assumptions = "Ruling correctness is not assessed automatically.")
      } else for (ep in c(FALSE, TRUE)) {
        actual <- state_value(pair$actual, game$homeTeam, ep); alternative <- state_value(pair$alternative, game$homeTeam, ep)
        value <- if (!is.null(actual$value) && !is.null(alternative$value)) actual$value - alternative$value else NULL
        metrics[[length(metrics) + 1L]] <- metric(paste0(id, if (ep) ":ruling_ep" else ":ruling"), "officiating", if (ep) "Ruling expected-points consequence" else "Observed ruling consequence", game$homeTeam, value, if (ep) "points" else "wp_delta", if (is.null(value)) "unavailable" else "supported", actual$reason %||% alternative$reason,
          id, p$play_id, c(pair$assumption, "Home-team perspective in both states; opponent benefit is its negative.", "Event-local comparison; never sum these into an alternate chance of winning.", "Ties excluded from published WP training; no overtime model."), WP_VERSION, actual = pair$actual, alternative = pair$alternative)
      }
    }
    if (num(p$down, 0) == 4) metrics[[length(metrics) + 1L]] <- if (!is.null(kernels$error)) metric(paste0(id, ":coaching"), "coaching", "Fourth-down decision cost", txt(p$posteam), unit = "wp_delta", status = "unavailable", reason = "model_artifact_unavailable", event = id, play = p$play_id, model = FOURTH_VERSION) else fourth_metric(p, game, kernels, num(request$config$closeCallTolerance, .01), promotion)
  }
  base <- safe_model(baseline_metrics(plays, game, model_dir))
  if (!is.null(base$error)) warnings <- c(warnings, paste0("Baseline analysis unavailable: ", base$error)) else metrics <- c(metrics, base)
  ftn <- rows_df(request$ftn)
  tags <- c(is_drop = "Charted drops", is_interception_worthy = "Interception-worthy throws", is_qb_fault_sack = "QB-attributed sacks", is_catchable_ball = "Catchable targets", is_contested_ball = "Contested targets", is_created_reception = "Receiver-created receptions")
  if (!nrow(ftn)) for (team in c(game$homeTeam, game$awayTeam)) metrics[[length(metrics) + 1L]] <- metric(paste0(game$id, ":charting:", team), "execution", "Execution charting", team, unit = "count", status = "unavailable", reason = "ftn_charting_unavailable", model = "FTN-charting", eligible = nrow(plays)) else {
    key <- if ("nflverse_play_id" %in% names(ftn)) "nflverse_play_id" else NULL
    if (is.null(key)) warnings <- c(warnings, "FTN join key unavailable; charting not joined.") else {
      ftn <- ftn[!duplicated(ftn[[key]]), , drop = FALSE]
      plays <- ensure_fields(plays, c("pass_attempt", "sack", "qb_spike", "play_type"))
      joined <- merge(plays[c("play_id", "posteam", "pass_attempt", "sack", "qb_spike", "play_type")], ftn, by.x = "play_id", by.y = key, all.x = TRUE)
      for (tag in intersect(names(tags), names(joined))) for (team in c(game$homeTeam, game$awayTeam)) {
        data <- joined[joined$posteam == team & !is.na(joined$posteam), , drop = FALSE]
        opportunity <- if (tag == "is_qb_fault_sack") !is.na(data$sack) & data$sack == 1 else !is.na(data$pass_attempt) & data$pass_attempt == 1 & (is.na(data$sack) | data$sack != 1) & (is.na(data$qb_spike) | data$qb_spike != 1) & data$play_type != "no_play"
        data <- data[which(opportunity), , drop = FALSE]
        known <- which(!is.na(data[[tag]])); incidents <- which(!is.na(data[[tag]]) & data[[tag]] %in% c(TRUE, 1, "true", "TRUE"))
        ids <- as.character(data$play_id[incidents])
        metrics[[length(metrics) + 1L]] <- metric(paste0(game$id, ":", tag, ":", team), "execution", tags[[tag]], team, if (length(known)) length(incidents) else NULL, "count", if (length(known)) "supported" else "unavailable", if (length(known)) NULL else "charting_tag_missing", if (length(ids)) paste0(game$id, ":", ids) else character(), ids,
          c("FTN charting labels, not calibrated outcome probabilities or error-attributable WPA.", "Coverage counts nonmissing charted labels; uncharted plays are not zero errors.", "FTN attribution and CC-BY-SA obligations apply."), "FTN-charting", nrow(data), length(known))
        for (j in incidents) if (!paste0(game$id, ":", data$play_id[[j]]) %in% vapply(events, function(e) e$id, character(1))) {
          p <- one_row(plays, match(data$play_id[[j]], plays$play_id))
          events[[length(events) + 1L]] <- list(id = event_id(game$id, p), playId = txt(p$play_id), quarter = num(p$qtr), clock = txt(p$time), description = txt(p$desc), kind = "execution", team = txt(p$posteam), reviewStatus = "not_reviewed")
        }
      }
    }
  }
  categories <- c("officiating", "coaching", "fumble", "kicking", "execution", "penalty_anomaly")
  coverage <- lapply(categories, function(category) {
    m <- Filter(function(x) x$category == category, metrics)
    # EP and WP views of one officiating event share one coverage count.
    if (category == "officiating") m <- Filter(function(x) x$unit == "wp_delta", m)
    eligible <- sum(vapply(m, function(x) x$coverage$eligible, numeric(1))); modeled <- sum(vapply(m, function(x) x$coverage$modeled, numeric(1)))
    list(category = category, status = if (!modeled) "unavailable" else if (modeled < eligible) "partial" else "available", eligible = eligible, modeled = modeled, reason = if (!length(m)) "no_eligible_events" else NULL)
  })
  source(file.path(root, "R/rarity.R"))
  metrics <- add_rarity(metrics, game, model_dir)
  model_manifest <- file.path(root, "models/manifest.json")
  models <- list(list(id = "nflfastR", version = WP_VERSION, trainingWindow = NULL, notes = "Published training excludes ties/OT; pinned artifact training cutoff unverified."), list(id = "nfl4th-adapted", version = FOURTH_VERSION, trainingWindow = NULL, notes = "Rule-adapted experimental scenarios; recorded observed-action diagnostics do not identify unchosen counterfactual outcomes."))
  if (file.exists(model_manifest)) models[[2]]$checksum <- model_hash(model_manifest)
  for (kind in c("fumble", "fg", "xp", "penalty")) {
    path <- file.path(model_dir, paste0(kind, ".rds"))
    if (file.exists(path)) { artifact <- readRDS(path); models[[length(models) + 1L]] <- list(id = kind, version = artifact$version, checksum = model_hash(path), trainingWindow = paste(artifact$trainingSeasons, collapse = ","), notes = artifact$featurePolicy) }
  }
  list(schemaVersion = 1L, metrics = metrics, events = events, timeline = timeline, coverage = coverage, models = models,
       warnings = as.list(unique(c(warnings, "Overall percentile unavailable: no validated comparable-coverage aggregation.", "Officiating correctness: not reviewed. No statistical result establishes intent.", if (isTRUE(promotion$passed)) "Coaching promotion gate passed for insensitive supported regulation states; upstream training cutoff and unchosen action outcomes remain unverified." else "Coaching promotion gate is absent, stale or failed: values remain experimental."))))
}
