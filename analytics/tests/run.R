root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
suppressPackageStartupMessages({ library(testthat); library(dplyr); library(tidyr); library(tibble) })
for (name in c("common", "states", "fourth", "baselines", "engine")) source(file.path(root, "R", paste0(name, ".R")))
game <- list(id = "2026_01_NE_SEA", season = 2026, week = 1, gameType = "REG", homeTeam = "SEA", awayTeam = "NE", homeScore = 13, awayScore = 10)
play <- list(play_id = 100, season = 2026, qtr = 2, half_seconds_remaining = 600, game_seconds_remaining = 2400, quarter_seconds_remaining = 600,
   home_team = "SEA", away_team = "NE", posteam = "SEA", defteam = "NE", score_differential = 0, down = 4, ydstogo = 2, yardline_100 = 45,
   posteam_timeouts_remaining = 2, defteam_timeouts_remaining = 1, home_opening_kickoff = 1, roof = "outdoors", spread_line = 3, total_line = 44.5,
   play_type = "run", desc = "Synthetic state used solely for branch tests", penalty = 0, time = "10:00")
test_that("state perspective swaps ownership, not just WP sign", {
  s <- state_from_play(play, game); flipped <- flip_state(s)
  expect_equal(flipped$posteam, "NE"); expect_equal(flipped$posteam_timeouts_remaining, 1)
  expect_equal(flipped$defteam_timeouts_remaining, 2); expect_equal(flipped$yardline_100, 55)
  expect_equal(flipped$receive_2h_ko, 1)
  expect_equal(state_value(s, "SEA")$value + state_value(s, "NE")$value, 1, tolerance = 1e-12)
  expect_equal(state_value(s, "SEA", TRUE)$value, -state_value(s, "NE", TRUE)$value)
  changed <- s; changed$spread_line <- 14
  expect_equal(state_value(changed, "SEA")$value, state_value(s, "SEA")$value)
  s$qtr <- 5; expect_match(state_reason(s), "overtime")
  s$qtr <- 4; s$game_seconds_remaining <- 0; expect_match(state_reason(s), "terminal")
  s$game_seconds_remaining <- 20; s$score_differential <- 0; expect_null(state_reason(s))
})
test_that("penalty constructors preserve clauses and reject erased outcomes", {
  p <- play; p$play_type <- "no_play"; p$penalty <- 1; p$penalty_yards <- 5
  p$desc <- "PENALTY on SEA-Player, False Start, 5 yards, enforced at NE 45 - No Play."
  nxt <- play; nxt$yardline_100 <- 50; nxt$ydstogo <- 7
  result <- penalty_states(p, nxt, game)
  expect_null(result$reason); expect_equal(result$alternative$yardline_100, 45)
  expect_equal(result$actual$game_seconds_remaining, result$alternative$game_seconds_remaining)
  p$desc <- paste(p$desc, "PENALTY on NE-Player, Defensive Holding, 5 yards, declined.")
  expect_length(parse_penalties(p$desc), 2); expect_equal(penalty_states(p, nxt, game)$reason, "multiple_or_unparsed_penalties")
  p$desc <- "PENALTY on NE-Player, Defensive Holding, 5 yards, declined."
  expect_equal(penalty_states(p, nxt, game)$reason, "penalty_declined")
  p$desc <- "PENALTY on NE-Player, Defensive Holding, 5 yards, offsetting."
  expect_equal(penalty_states(p, nxt, game)$reason, "penalty_offsetting")
  p$desc <- "Pass intercepted. PENALTY on NE-Player, Defensive Holding, 5 yards, enforced."
  p$interception <- 1; expect_match(penalty_states(p, nxt, game)$reason, "turnover")
  p$interception <- 0; p$touchdown <- 1; expect_match(penalty_states(p, nxt, game)$reason, "scoring")
})
test_that("fumble predictors never use recovery location or eventual gain", {
  p <- play; p$fumble <- 1; p$fumbled_1_team <- "SEA"; p$fumble_recovery_1_team <- "NE"; p$sack <- 0; p$rush_attempt <- 1; p$fumble_forced <- 1
  d <- fumble_rows(rows_df(list(p))); expect_equal(nrow(d), 1)
  expect_equal(d$y, 0); p$fumble_out_of_bounds <- 1; expect_equal(nrow(fumble_rows(rows_df(list(p)))), 0)
  p$fumble_out_of_bounds <- 0; p$aborted_play <- 1; expect_equal(nrow(fumble_rows(rows_df(list(p)))), 0)
})
test_that("future model data cannot score an older game", {
  a <- list(trainedThrough = "2025_22_SEA_NE")
  expect_error(predict_baseline(a, data.frame(game_id = "2024_01_NE_SEA")), "leakage")
})
test_that("2026 fourth-down kernel is offline and keeps outcomes out of decisions", {
  kernel <- fourth_kernel(root, 65L); alternate <- fourth_kernel(root, 80L); legacy <- fourth_kernel(root, 75L, TRUE)
  context <- fourth_context(play, game); expect_null(context$reason)
  current <- fourth_prediction(kernel, context); expect_true(all(is.finite(current$values)))
  changed <- play; changed$yards_gained <- -20; changed$fourth_down_converted <- 0; changed$touchdown <- 1
  expect_equal(fourth_prediction(kernel, fourth_context(changed, game))$values, current$values)
  sensitivity <- fourth_prediction(alternate, context); expect_true(any(abs(current$values - sensitivity$values) > 1e-8))
  # Upstream add_probs, using its documented cache mechanism preloaded from frozen artifacts.
  options(nfl4th.keep_games = TRUE, nfl4th.force_cache = "true")
  cache_dir <- tools::R_user_dir("nfl4th", "cache"); dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
  for (name in c("fd_model", "wp_model")) file.copy(file.path(root, "models", paste0(name, ".rds")), file.path(cache_dir, paste0(name, ".rds")), overwrite = TRUE)
  ref <- suppressWarnings(suppressMessages(getFromNamespace("add_probs", "nfl4th")(context$data)))
  same <- fourth_prediction(legacy, context)
  expect_equal(unname(same$values), c(ref$go_wp, ref$fg_wp, ref$punt_wp), tolerance = 1e-8)
  halftime <- context$data; halftime$qtr <- 2; halftime$half_seconds_remaining <- 0
  halftime$home_timeouts_remaining <- 0; halftime$away_timeouts_remaining <- 1
  next_half <- kernel$flip_half(halftime)
  expect_equal(next_half$qtr, 3); expect_equal(next_half$yardline_100, 65)
  expect_equal(next_half$home_timeouts_remaining, 3); expect_equal(next_half$away_timeouts_remaining, 3)
  expect_equal(alternate$flip_half(halftime)$yardline_100, 80)
  missing <- play; missing$spread_line <- NULL; expect_match(fourth_context(missing, game)$reason, "missing_schedule")
})
fixture_root <- "tests/fixtures/real"
if (file.exists(file.path(fixture_root, "2026_01_NE_SEA.pbp.csv"))) {
  test_that("real historical and 2026 games produce evidence-backed JSON", {
    for (gid in c("2023_01_DET_KC", "2026_01_NE_SEA")) {
      pbp <- read.csv(file.path(fixture_root, paste0(gid, ".pbp.csv")), na.strings = c("", "NA"), check.names = FALSE)
      ftn <- read.csv(file.path(fixture_root, paste0(gid, ".ftn_charting.csv")), na.strings = c("", "NA"), check.names = FALSE)
      g <- list(id = gid, season = pbp$season[[1]], week = pbp$week[[1]], gameType = "REG", homeTeam = pbp$home_team[[1]], awayTeam = pbp$away_team[[1]], homeScore = pbp$home_score[[1]], awayScore = pbp$away_score[[1]])
      response <- analyze_game(list(game = g, plays = pbp, ftn = ftn, config = list(), snapshots = list()), root)
      expect_gt(length(response$metrics), 0); expect_equal(length(response$timeline), nrow(pbp))
      expect_gt(sum(vapply(response$timeline, function(x) !is.null(x$homeWp), logical(1))), 50)
      coaching <- Filter(function(x) x$category == "coaching" && !is.null(x$value), response$metrics)
      expect_gt(length(coaching), 0)
      expect_true(all(vapply(coaching, function(x) x$value >= 0 && x$value <= 1 && x$unit == "wp_delta", logical(1))))
      expect_false(anyDuplicated(vapply(response$events, function(x) x$id, character(1))) > 0)
      event_ids <- vapply(response$events, function(x) x$id, character(1))
      expect_true(all(unlist(lapply(response$metrics, `[[`, "eventIds"), use.names = FALSE) %in% event_ids))
      write_json(response, file.path(root, "tests", paste0("output-", gid, ".json")))
    }
  })
}
write_json(list(schemaVersion = 1L, version = FOURTH_VERSION, parityPassed = TRUE, ruleTransitionTestsPassed = TRUE,
  predecisionOnlyPassed = TRUE, adapterChecksum = model_hash(file.path(root, "R/fourth.R")), statesChecksum = model_hash(file.path(root, "R/states.R")),
  note = "Recorded only after every executable assertion above passes."), file.path(root, "models/test-evidence.json"))
message("Analytics tests passed.")
