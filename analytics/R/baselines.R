BASELINE_VERSION <- "under-review-contextual-baselines-v1"
ensure_fields <- function(df, fields) { for (f in fields) if (!f %in% names(df)) df[[f]] <- NA; df }
baseline_features <- function(pbp) {
  pbp <- ensure_fields(pbp, c("game_id", "play_id", "season", "posteam", "defteam", "home_team", "roof", "qtr", "down", "ydstogo", "yardline_100", "score_differential", "half_seconds_remaining", "play_type", "desc", "penalty", "fumble", "fumble_out_of_bounds", "fumble_recovery_1_team", "fumble_recovery_2_team", "fumbled_1_team", "fumbled_2_team", "aborted_play", "touchback", "sack", "rush_attempt", "pass_attempt", "fumble_forced", "field_goal_attempt", "field_goal_result", "extra_point_attempt", "extra_point_result", "kick_distance", "first_down_penalty"))
  pbp$roof_group <- ifelse(is.na(pbp$roof), "unknown", ifelse(pbp$roof %in% c("dome", "closed"), "indoor", "outdoor"))
  pbp$roof_group <- factor(pbp$roof_group, levels = c("outdoor", "indoor", "unknown"))
  pbp$era <- pmax(0, as.numeric(pbp$season) - 2015)
  pbp$is_sack <- as.integer(!is.na(pbp$sack) & pbp$sack == 1)
  pbp$is_rush <- as.integer(!is.na(pbp$rush_attempt) & pbp$rush_attempt == 1)
  pbp$is_forced <- as.integer(!is.na(pbp$fumble_forced) & pbp$fumble_forced == 1)
  pbp$desc[is.na(pbp$desc)] <- ""
  pbp
}
fumble_rows <- function(pbp) {
  d <- baseline_features(pbp)
  yes <- !is.na(d$fumble) & d$fumble == 1 & d$play_type %in% c("run", "pass") &
    (is.na(d$fumble_out_of_bounds) | d$fumble_out_of_bounds == 0) & (is.na(d$aborted_play) | d$aborted_play == 0) &
    (is.na(d$touchback) | d$touchback == 0) & (is.na(d$fumbled_2_team) | d$fumbled_2_team == "") &
    (is.na(d$fumble_recovery_2_team) | d$fumble_recovery_2_team == "") &
    !is.na(d$fumbled_1_team) & !is.na(d$fumble_recovery_1_team) &
    !grepl("out of bounds|out-of-bounds|touchback|aborted", d$desc, ignore.case = TRUE) &
    (is.na(d$penalty) | d$penalty == 0)
  d <- d[which(yes), , drop = FALSE]
  d$y <- as.integer(d$fumbled_1_team == d$fumble_recovery_1_team)
  d[complete.cases(d[c("y", "yardline_100", "down", "ydstogo", "score_differential")]), , drop = FALSE]
}
kick_rows <- function(pbp, xp = FALSE) {
  d <- baseline_features(pbp)
  outcome <- if (xp) d$extra_point_result else d$field_goal_result
  attempt <- if (xp) d$extra_point_attempt else d$field_goal_attempt
  d$y <- as.integer(outcome %in% c("made", "good"))
  keep <- !is.na(attempt) & attempt == 1 & outcome %in% c("made", "missed", "good", "failed") &
    (is.na(d$penalty) | d$penalty == 0) & !is.na(d$kick_distance) & d$kick_distance >= 18 & d$kick_distance <= 70
  d[which(keep), , drop = FALSE]
}
PENALTY_FAMILIES <- list(presnap = c("False Start", "Delay of Game"), offensive_holding = "Offensive Holding",
                         defensive_holding = c("Defensive Holding", "Illegal Contact"), pass_interference = "Defensive Pass Interference")
penalty_game_rows <- function(pbp) {
  d <- baseline_features(pbp)
  d <- d[order(d$game_id, d$play_id), , drop = FALSE]
  results <- list()
  for (gid in unique(d$game_id)) {
    g <- d[d$game_id == gid, , drop = FALSE]
    clauses <- unlist(lapply(seq_len(nrow(g)), function(i) lapply(parse_penalties(g$desc[[i]]), function(p) { p$first_down <- isTRUE(g$first_down_penalty[[i]] == 1); p })), recursive = FALSE)
    for (team in unique(stats::na.omit(c(g$posteam, g$defteam)))) for (family in names(PENALTY_FAMILIES)) {
      defensive <- family %in% c("defensive_holding", "pass_interference")
      side <- if (defensive) g$defteam else g$posteam
      eligible <- !is.na(side) & side == team & (g$play_type %in% c("pass", "run") | (g$play_type == "no_play" & !is.na(g$down)))
      if (defensive) eligible <- eligible & (g$play_type == "pass" | grepl(" pass ", g$desc))
      n <- sum(eligible, na.rm = TRUE)
      if (!n) next
      counted <- Filter(function(p) identical(p$team, team) && p$status == "accepted" && !is.na(p$type) && p$type %in% PENALTY_FAMILIES[[family]], clauses)
      opp <- unique(stats::na.omit(if (defensive) g$posteam[which(eligible)] else g$defteam[which(eligible)]))
      results[[length(results) + 1L]] <- data.frame(game_id = gid, season = g$season[[1]], team = team, opponent = if (length(opp)) opp[[1]] else "UNKNOWN", family = family,
        y = length(counted), first_downs = sum(vapply(counted, function(p) p$first_down, logical(1))), opportunities = n,
        home = as.integer(team == g$home_team[[1]]), late_share = mean(g$half_seconds_remaining[which(eligible)] <= 120, na.rm = TRUE),
        third_share = mean(g$down[which(eligible)] == 3, na.rm = TRUE))
    }
  }
  if (!length(results)) return(data.frame())
  out <- dplyr::bind_rows(results)
  out$late_share[!is.finite(out$late_share)] <- 0; out$third_share[!is.finite(out$third_share)] <- 0
  out
}
add_prior_rates <- function(d, history = NULL) {
  # Prior-game only. Identical game IDs are never admitted to their own tendencies.
  reference <- dplyr::bind_rows(history, d)
  reference <- reference[!duplicated(reference[c("game_id", "team", "family")]), , drop = FALSE]
  d$prior_team_rate <- d$prior_opponent_rate <- NA_real_
  for (i in seq_len(nrow(d))) {
    prior <- reference[reference$game_id < d$game_id[[i]] & reference$family == d$family[[i]], , drop = FALSE]
    base <- (sum(prior$y) + 1) / (sum(prior$opportunities) + 100)
    own <- prior[prior$team == d$team[[i]], , drop = FALSE]
    opp <- prior[prior$opponent == d$opponent[[i]], , drop = FALSE]
    d$prior_team_rate[[i]] <- (sum(own$y) + base * 200) / (sum(own$opportunities) + 200)
    d$prior_opponent_rate[[i]] <- (sum(opp$y) + base * 200) / (sum(opp$opportunities) + 200)
  }
  d$family <- factor(d$family, levels = names(PENALTY_FAMILIES))
  d
}
probability_diagnostics <- function(y, p) {
  if (!length(y)) return(list(n = 0L, brier = NULL, logLoss = NULL, bins = list()))
  p <- pmin(1 - 1e-8, pmax(1e-8, p))
  bins <- cut(p, breaks = seq(0, 1, .1), include.lowest = TRUE)
  table <- lapply(levels(bins), function(b) { take <- which(bins == b); list(bin = b, n = length(take), predicted = if (length(take)) mean(p[take]) else NULL, observed = if (length(take)) mean(y[take]) else NULL) })
  list(n = length(y), brier = mean((y - p)^2), logLoss = -mean(y * log(p) + (1 - y) * log(1 - p)), bins = table)
}
fit_baseline <- function(kind, train, calibration, test) {
  min_n <- if (kind == "penalty") 500 else 100
  if (nrow(train) < min_n || nrow(calibration) < 30 || nrow(test) < 30) stop("Insufficient chronological sample for ", kind)
  if (kind == "penalty") {
    formula <- y ~ family + home + late_share + third_share + prior_team_rate + prior_opponent_rate + offset(log(opportunities))
    model <- glm(formula, data = train, family = poisson())
    dispersion <- sum(residuals(model, type = "pearson")^2) / model$df.residual
    if (dispersion > 1.5) model <- MASS::glm.nb(formula, data = train)
    cal <- predict(model, calibration, type = "response"); pred <- predict(model, test, type = "response")
    diagnostics <- list(n = nrow(test), countRmse = sqrt(mean((test$y - pred)^2)), meanObserved = mean(test$y), meanPredicted = mean(pred), poissonDispersion = dispersion,
       calibrationRatio = sum(calibration$y) / sum(cal), distribution = if (inherits(model, "negbin")) "negative_binomial" else "poisson")
    calibrator <- sum(calibration$y) / sum(cal)
  } else {
    formula <- switch(kind,
      fumble = y ~ is_sack + is_rush + is_forced + splines::ns(yardline_100, df = 3) + down + log1p(ydstogo),
      fg = y ~ splines::ns(kick_distance, df = 4) + era + roof_group,
      xp = y ~ kick_distance + era + roof_group)
    # Preserve missing-environment category; rank deficiency is permitted but unknown predictions fail closed.
    model <- glm(formula, data = train, family = binomial())
    cp <- pmin(1 - 1e-6, pmax(1e-6, predict(model, calibration, type = "response")))
    calibrator <- glm(calibration$y ~ 1 + offset(qlogis(cp)), family = binomial())$coefficients[[1]]
    pred <- plogis(qlogis(pmin(1 - 1e-6, pmax(1e-6, predict(model, test, type = "response")))) + calibrator)
    diagnostics <- probability_diagnostics(test$y, pred)
    diagnostics$constantBrier <- mean((test$y - mean(train$y))^2)
  }
  list(kind = kind, version = BASELINE_VERSION, model = model, calibrator = calibrator, diagnostics = diagnostics,
       trainingSeasons = sort(unique(train$season)), calibrationSeasons = sort(unique(calibration$season)), testSeasons = sort(unique(test$season)),
       maxTrainingGame = max(train$game_id), trainedThrough = max(calibration$game_id),
       featurePolicy = "No future games, recovery locations, eventual yards gained, or kick outcomes in predictors.")
}
predict_baseline <- function(artifact, df) {
  if (any(df$game_id <= artifact$trainedThrough)) stop("Model leakage guard: game is not after the calibration window")
  p <- suppressWarnings(predict(artifact$model, df, type = "response"))
  if (artifact$kind == "penalty") p * artifact$calibrator else plogis(qlogis(pmin(1 - 1e-6, pmax(1e-6, p))) + artifact$calibrator)
}
baseline_metrics <- function(pbp, game, model_dir) {
  results <- list()
  datasets <- list(fumble = fumble_rows(pbp), fg = kick_rows(pbp), xp = kick_rows(pbp, TRUE))
  for (kind in names(datasets)) {
    rows <- datasets[[kind]]; category <- if (kind == "fumble") "fumble" else "kicking"
    label <- switch(kind, fumble = "Fumble recoveries above expectation", fg = "Field-goal points above expectation", xp = "Extra-point points above expectation")
    path <- file.path(model_dir, paste0(kind, ".rds"))
    artifact <- if (file.exists(path)) readRDS(path) else NULL
    for (team in c(game$homeTeam, game$awayTeam)) {
      data <- rows[which(if (kind == "fumble") rows$fumbled_1_team %in% c(game$homeTeam, game$awayTeam) else rows$posteam == team), , drop = FALSE]
      assumptions <- if (kind == "fumble") c("Ordinary single in-bounds fumbles only; recovery creation separated from recovery outcome.", "Recovery residual only; no unsupported recovery WP branches.") else c("Nullified/blocked attempts and returns excluded; blocked kicks are not automatically kicker errors.", "Distance, era and reported roof; no weather or kicker-history adjustment in this model.")
      if (is.null(artifact)) { results[[length(results) + 1L]] <- metric(paste0(game$id, ":", kind, ":", team), category, label, team, unit = if (kind == "fumble") "recoveries" else "points", status = "unavailable", reason = "baseline_not_trained", model = BASELINE_VERSION, assumptions = assumptions, eligible = nrow(data)); next }
      pred <- if (nrow(data)) safe_model(predict_baseline(artifact, data)) else numeric()
      if (is.list(pred) || any(!is.finite(pred))) { results[[length(results) + 1L]] <- metric(paste0(game$id, ":", kind, ":", team), category, label, team, unit = if (kind == "fumble") "recoveries" else "points", status = "unavailable", reason = "baseline_leakage_or_domain_guard", model = BASELINE_VERSION, assumptions = assumptions, eligible = nrow(data)); next }
      scale <- if (kind == "fg") 3 else 1
      observed <- data$y
      if (kind == "fumble") {
        pred <- ifelse(data$fumbled_1_team == team, pred, 1 - pred)
        observed <- as.integer(data$fumble_recovery_1_team == team)
        assumptions <- c(assumptions, "Includes both own and opposing fumbles; two team views share the same events and sum to zero.")
      }
      ids <- as.character(data$play_id)
      results[[length(results) + 1L]] <- metric(paste0(game$id, ":", kind, ":", team), category, label, team, sum(scale * (observed - pred)), if (kind == "fumble") "recoveries" else "points", event = if (length(ids)) paste0(game$id, ":", ids) else character(), play = ids, assumptions = c(assumptions, paste0("Chronological training: ", paste(artifact$trainingSeasons, collapse = ","), "; calibration: ", paste(artifact$calibrationSeasons, collapse = ","))), model = paste0(BASELINE_VERSION, "-", substr(model_hash(path), 1, 12), if (kind == "fumble") "-team-recovery-v1" else ""), eligible = nrow(data), modeled = nrow(data))
    }
  }
  counts <- penalty_game_rows(pbp)
  path <- file.path(model_dir, "penalty.rds")
  artifact <- if (file.exists(path)) readRDS(path) else NULL
  if (!is.null(artifact) && nrow(counts)) counts <- add_prior_rates(counts, artifact$history)
  for (i in seq_len(nrow(counts))) {
    row <- counts[i, , drop = FALSE]
    pred <- if (is.null(artifact)) list(error = "missing") else safe_model(predict_baseline(artifact, row))
    good <- is.numeric(pred) && length(pred) == 1 && is.finite(pred)
    results[[length(results) + 1L]] <- metric(paste0(game$id, ":penalty:", row$team, ":", row$family), "penalty_anomaly", paste0(row$family, " called penalties above expectation"), row$team,
      if (good) row$y - pred else NULL, "calls", if (good) "supported" else "unavailable", if (good) NULL else "baseline_not_trained_or_domain_guard", assumptions = c("Called/enforced penalties, not adjudicated foul correctness.", "Family-specific opportunity counts; prior-game team/opponent tendencies; crew effects not normalized away.", paste0("Observed ", row$y, " across ", row$opportunities, " opportunities; penalty-generated first downs ", row$first_downs, ".")), model = BASELINE_VERSION, eligible = row$opportunities, modeled = if (good) row$opportunities else 0)
  }
  results
}
