FOURTH_VERSION <- "under-review-nfl4th-2026-v1"
fourth_kernel <- function(root, kickoff_yardline = 65L, legacy = FALSE) {
  env <- new.env(parent = globalenv())
  for (f in c("helpers.R", "apply_win_prob.R", "decision_functions.R", "wrapper.R")) {
    code <- readLines(file.path(root, "vendor/nfl4th", f), warn = FALSE)
    # Only kickoff continuation constants change; original vendor files remain byte-for-byte intact.
    if (!legacy && f %in% c("helpers.R", "decision_functions.R")) {
      code <- gsub("as.integer(75)", "as.integer(kickoff_yardline)", code, fixed = TRUE)
      code <- gsub("yardline_100 = 75,", "yardline_100 = kickoff_yardline,", code, fixed = TRUE)
      code <- gsub("end_of_half == 1, 75L,", "end_of_half == 1, kickoff_yardline,", code, fixed = TRUE)
    }
    eval(parse(text = code), envir = env)
  }
  env$kickoff_yardline <- as.integer(kickoff_yardline)
  for (object in c("fg_model", "two_pt_model", "punt_df")) assign(object, readRDS(file.path(root, "models", paste0(object, ".rds"))), envir = env)
  fd <- xgboost::xgb.load.raw(readRDS(file.path(root, "models/fd_model.rds")))
  wp <- xgboost::xgb.load.raw(readRDS(file.path(root, "models/wp_model.rds")))
  env$fd_model <- function() fd; env$wp_model <- function() wp
  if (!legacy) {
    original_half <- env$flip_half
    env$flip_half <- function(df) {
      ending <- df$qtr == 2 & df$half_seconds_remaining == 0
      result <- original_half(df)
      result$home_timeouts_remaining[ending] <- 3
      result$away_timeouts_remaining[ending] <- 3
      result
    }
    original_wp <- env$calculate_win_probability
    env$calculate_win_probability <- function(pbp_data) {
      # Timeouts must follow current possession for BOTH components, including the EP input.
      pbp_data <- pbp_data |> mutate(
        elapsed_share = (3600 - game_seconds_remaining) / 3600,
        spread_time = spread_line * exp(-4 * elapsed_share),
        posteam_timeouts_remaining = if_else(posteam == home_team, home_timeouts_remaining, away_timeouts_remaining),
        defteam_timeouts_remaining = if_else(posteam == home_team, away_timeouts_remaining, home_timeouts_remaining))
      original_wp(pbp_data)
    }
  }
  env
}
fourth_context <- function(p, game) {
  s <- state_from_play(p, game)
  reason <- state_reason(s, TRUE)
  if (!is.null(reason)) return(list(reason = reason))
  if (s$down != 4 || s$game_seconds_remaining <= 15 || s$yardline_100 > 89 || s$ydstogo > 30) return(list(reason = "outside_fourth_down_domain"))
  if (flag(p$penalty) || flag(p$aborted_play) || txt(p$play_type) %in% c("no_play", "qb_kneel") || grepl("fake", txt(p$desc), ignore.case = TRUE)) return(list(reason = "chosen_action_ambiguous"))
  action <- if (flag(p$punt_attempt) || txt(p$play_type) == "punt") "punt" else if (flag(p$field_goal_attempt) || txt(p$play_type) == "field_goal") "fg" else if (txt(p$play_type) %in% c("run", "pass")) "go" else NA_character_
  if (is.na(action)) return(list(reason = "chosen_action_ambiguous"))
  provider <- game$providerData %||% list()
  spread <- num(p$spread_line %||% provider$spread_line)
  total <- num(p$total_line %||% provider$total_line)
  opening <- num(p$home_opening_kickoff)
  if (!is.finite(spread) || !is.finite(total) || !is.finite(opening)) return(list(reason = "missing_schedule_lines_or_kickoff"))
  roof <- if (s$roof %in% c("open", "closed", "retractable")) "retractable" else s$roof
  df <- as.data.frame(s, stringsAsFactors = FALSE)
  df$roof <- roof; df$spread_line <- spread; df$total_line <- total
  df$type <- if (txt(game$gameType %||% p$season_type) == "REG") "reg" else "post"
  df$era0 <- 0; df$era1 <- 0; df$era2 <- 0; df$era3 <- as.integer(s$season <= 2017); df$era4 <- as.integer(s$season > 2017)
  df$outdoors <- as.integer(roof == "outdoors"); df$dome <- as.integer(roof == "dome"); df$retractable <- as.integer(roof == "retractable")
  df$fg_model_roof <- factor(paste0(df$outdoors, as.integer(s$season >= 2020)))
  df$home_total <- (total + spread) / 2; df$away_total <- (total - spread) / 2
  df$posteam_spread <- if (s$posteam == s$home_team) spread else -spread
  df$posteam_total <- if (s$posteam == s$home_team) df$home_total else df$away_total
  df$home_opening_kickoff <- opening
  df$home_receive_2h_ko <- if (s$qtr <= 2) if (opening == 1) -1 else 1 else 0
  df$elapsed_share <- (3600 - s$game_seconds_remaining) / 3600
  df$spread_time <- spread * exp(-4 * df$elapsed_share)
  df$home_timeouts_remaining <- if (s$posteam == s$home_team) s$posteam_timeouts_remaining else s$defteam_timeouts_remaining
  df$away_timeouts_remaining <- if (s$posteam == s$away_team) s$posteam_timeouts_remaining else s$defteam_timeouts_remaining
  df$original_posteam <- s$posteam; df$runoff <- 0L
  list(data = df, action = action, reason = NULL)
}
fourth_prediction <- function(kernel, context) {
  result <- suppressWarnings(suppressMessages(kernel$add_probs(context$data)))
  values <- c(go = result$go_wp[[1]], fg = result$fg_wp[[1]], punt = result$punt_wp[[1]])
  if (context$data$yardline_100 >= 53) values[["fg"]] <- NA_real_
  if (any(values[is.finite(values)] < 0 | values[is.finite(values)] > 1)) stop("Invalid fourth-down prediction")
  if (!is.finite(values[[context$action]])) stop("Chosen action unavailable")
  list(values = values, cost = max(values, na.rm = TRUE) - values[[context$action]], best = names(which.max(replace(values, is.na(values), -Inf))),
       firstDownProbability = result$first_down_prob[[1]], fieldGoalMakeProbability = result$fg_make_prob[[1]])
}
fourth_metric <- function(p, game, kernels, tolerance = .01, promotion = list(passed = FALSE, reason = "validation_gate_unavailable")) {
  id <- event_id(game$id, p); context <- fourth_context(p, game)
  assumptions <- c("Spread-adjusted nfl4th blended WP; distinct from officiating WP.", "Six seconds per action; no added successful-conversion runoff.", "No go-for-it turnover returns; kicking ignores kicker identity/weather; ordinary kickoff continuations only.", "Close-call tolerance is a product rule of 1 percentage point, not model uncertainty.", "Upstream training cutoff unverified; current-season validation status is documented separately.")
  fail <- function(reason) metric(paste0(id, ":coaching"), "coaching", "Fourth-down decision cost", txt(p$posteam), unit = "wp_delta", status = "unavailable", reason = reason, event = id, play = p$play_id, model = FOURTH_VERSION, assumptions = assumptions)
  if (!is.null(context$reason)) return(fail(context$reason))
  predictions <- lapply(kernels, function(k) safe_model(fourth_prediction(k, context)))
  if (any(vapply(predictions, function(p) !is.null(p$error), logical(1)))) return(fail("fourth_down_model_error"))
  baseline <- predictions[[1]]
  sensitive <- length(unique(vapply(predictions, function(p) p$best, character(1)))) > 1 || length(unique(vapply(predictions, function(p) p$cost > tolerance, logical(1)))) > 1
  assumptions <- c(assumptions, paste0("Kickoff continuation scenarios: ", paste(names(kernels), collapse = ", "), "; sensitivity is not a confidence interval."),
    paste0("Chosen action: ", context$action, "; preferred baseline action: ", baseline$best, "; expected WP go/FG/punt: ", paste(format(round(baseline$values, 5), nsmall = 5), collapse = "/")))
  promoted <- isTRUE(promotion$passed) && !sensitive && length(kernels) > 2
  assumptions <- c(assumptions, "A supported value is a model-relative estimate in a tested domain, not a proven causal cost.")
  metric(paste0(id, ":coaching"), "coaching", "Fourth-down decision cost", txt(p$posteam), baseline$cost, "wp_delta", if (promoted) "supported" else "experimental", if (sensitive) "kickoff_assumption_sensitive" else if (!promoted) promotion$reason %||% "empirical_scenario_unavailable" else if (baseline$cost <= tolerance) "close_call" else NULL, id, p$play_id,
         assumptions, FOURTH_VERSION, actual = as.list(context$data[1, ]), alternative = list(action = baseline$best, expectedWp = baseline$values[[baseline$best]]))
}
