WP_VERSION <- "nflfastR-6.0.0-fastrmodels-2.1.0-nonspread-regulation"
state_from_play <- function(p, game) {
  home <- txt(game_value(game, "homeTeam", "home_team", p$home_team))
  away <- txt(game_value(game, "awayTeam", "away_team", p$away_team))
  season <- num(game$season %||% p$season)
  qtr <- num(p$qtr)
  receive <- num(p$receive_2h_ko)
  opening <- num(p$home_opening_kickoff)
  if (!is.finite(receive) && is.finite(qtr) && qtr <= 2 && is.finite(opening)) receive <- as.integer((txt(p$posteam) == home && opening == 0) || (txt(p$posteam) == away && opening == 1))
  if (is.finite(qtr) && qtr > 2) receive <- 0
  list(season = season, home_team = home, away_team = away, posteam = txt(p$posteam), qtr = qtr,
       half_seconds_remaining = num(p$half_seconds_remaining), game_seconds_remaining = num(p$game_seconds_remaining),
       quarter_seconds_remaining = num(p$quarter_seconds_remaining), score_differential = num(p$score_differential),
       down = num(p$down), ydstogo = num(p$ydstogo), yardline_100 = num(p$yardline_100),
       posteam_timeouts_remaining = num(p$posteam_timeouts_remaining), defteam_timeouts_remaining = num(p$defteam_timeouts_remaining),
       receive_2h_ko = receive, roof = txt(p$roof %||% game$roof, NA_character_), spread_line = 0)
}
state_reason <- function(s, ep = FALSE) {
  if (!is.finite(s$qtr) || s$qtr > 4 || s$qtr < 1) return("unsupported_overtime_or_period")
  req <- c("half_seconds_remaining", "game_seconds_remaining", "score_differential", "down", "ydstogo", "yardline_100", "posteam_timeouts_remaining", "defteam_timeouts_remaining", "receive_2h_ko")
  if (any(!vapply(s[req], function(x) length(x) == 1 && is.finite(x), logical(1)))) return("missing_state_fields")
  if (!s$posteam %in% c(s$home_team, s$away_team) || !nzchar(s$home_team) || !nzchar(s$away_team)) return("missing_possession")
  if (s$half_seconds_remaining <= 0 || s$game_seconds_remaining <= 0) return("unsupported_terminal_or_halftime")
  if (s$half_seconds_remaining > 1800 || s$game_seconds_remaining > 3600 || !s$down %in% 1:4 || s$ydstogo <= 0 || s$ydstogo > 99 || s$yardline_100 <= 0 || s$yardline_100 >= 100) return("unsupported_state_domain")
  if (!s$posteam_timeouts_remaining %in% 0:3 || !s$defteam_timeouts_remaining %in% 0:3 || !s$receive_2h_ko %in% 0:1) return("invalid_timeout_or_kickoff_state")
  if (ep && (!is.finite(s$season) || is.na(s$roof) || !s$roof %in% c("outdoors", "dome", "open", "closed", "retractable"))) return("missing_environment")
  NULL
}
state_value <- function(s, team, ep = FALSE) {
  reason <- state_reason(s, ep)
  if (!is.null(reason)) return(list(value = NULL, reason = reason))
  result <- safe_model(if (ep) nflfastR::calculate_expected_points(as.data.frame(s))$ep[[1]] else nflfastR::calculate_win_probability(as.data.frame(s))$wp[[1]])
  if (is.list(result)) return(list(value = NULL, reason = "state_model_error"))
  value <- if (team == s$posteam) result else if (ep) -result else 1 - result
  list(value = value, reason = NULL)
}
flip_state <- function(s) {
  s$posteam <- if (s$posteam == s$home_team) s$away_team else s$home_team
  s$score_differential <- -s$score_differential
  s$yardline_100 <- 100 - s$yardline_100
  s$down <- 1; s$ydstogo <- min(10, s$yardline_100)
  t <- s$posteam_timeouts_remaining; s$posteam_timeouts_remaining <- s$defteam_timeouts_remaining; s$defteam_timeouts_remaining <- t
  s$receive_2h_ko <- if (s$qtr <= 2) 1 - s$receive_2h_ko else 0
  s
}
parse_penalties <- function(description) {
  # All clauses are retained, even when no quantitative constructor supports them.
  text <- txt(description)
  locations <- gregexpr("PENALTY on |Penalty on |PENALTY ", text, perl = TRUE)[[1]]
  if (locations[[1]] < 0) return(list())
  ends <- c(locations[-1] - 1L, nchar(text))
  lapply(seq_along(locations), function(i) {
    clause <- substr(text, locations[[i]], ends[[i]])
    team <- sub("^(?:PENALTY|Penalty)(?: on)? ([A-Z]{2,3})[- ,].*$", "\\1", clause, perl = TRUE)
    if (identical(team, clause)) team <- NA_character_
    type <- sub("^(?:PENALTY|Penalty)(?: on)? [^,]+, ([^,]+),.*$", "\\1", clause, perl = TRUE)
    if (identical(type, clause)) type <- NA_character_
    list(team = team, type = type, text = clause,
         status = if (grepl("offset", clause, ignore.case = TRUE)) "offsetting" else if (grepl("declined", clause, ignore.case = TRUE)) "declined" else "accepted")
  })
}
penalty_states <- function(p, next_p, game) {
  clauses <- parse_penalties(p$desc)
  fail <- function(reason) list(reason = reason, clauses = clauses)
  if (length(clauses) != 1) return(fail("multiple_or_unparsed_penalties"))
  cl <- clauses[[1]]
  if (cl$status != "accepted") return(fail(paste0("penalty_", cl$status)))
  if (is.null(next_p)) return(fail("missing_post_ruling_state"))
  pre <- state_from_play(p, game); post <- state_from_play(next_p, game)
  if (!is.null(state_reason(pre)) || !is.null(state_reason(post))) return(fail("unsupported_state"))
  if (pre$qtr != post$qtr || pre$half_seconds_remaining <= 120) return(fail("clock_or_period_ambiguity"))
  if (flag(p$replay_or_challenge) || flag(p$touchdown) || flag(p$interception) || flag(p$fumble) || flag(p$safety) || flag(p$field_goal_attempt)) return(fail("scoring_turnover_or_replay_requires_review"))
  if (pre$posteam != post$posteam || pre$score_differential != post$score_differential || pre$posteam_timeouts_remaining != post$posteam_timeouts_remaining || pre$defteam_timeouts_remaining != post$defteam_timeouts_remaining) return(fail("intervening_state_change"))
  pre_snap <- c("False Start", "Delay of Game", "Encroachment", "Neutral Zone Infraction")
  if (cl$type %in% pre_snap && txt(p$play_type) == "no_play") {
    # Evaluate immediately after enforcement at the same event clock. The next row verifies geometry only.
    yards <- num(p$penalty_yards)
    offense <- identical(cl$team, pre$posteam)
    expected_y <- pre$yardline_100 + if (offense) yards else -yards
    if (!is.finite(yards) || abs(post$yardline_100 - expected_y) > .51) return(fail("enforcement_geometry_mismatch"))
    expected_down <- if (!offense && yards >= pre$ydstogo) 1 else pre$down
    expected_distance <- if (!offense && yards >= pre$ydstogo) min(10, expected_y) else pre$ydstogo + if (offense) yards else -yards
    if (post$down != expected_down || abs(post$ydstogo - expected_distance) > .51) return(fail("enforcement_down_mismatch"))
    post$half_seconds_remaining <- pre$half_seconds_remaining; post$game_seconds_remaining <- pre$game_seconds_remaining; post$quarter_seconds_remaining <- pre$quarter_seconds_remaining
    return(list(actual = post, alternative = pre, clauses = clauses, assumption = "Same-clock state without presnap enforcement; does not imply the foul was incorrectly called."))
  }
  first_down_types <- c("Defensive Holding", "Illegal Contact", "Defensive Pass Interference", "Roughing the Passer")
  base <- strsplit(txt(p$desc), "PENALTY|Penalty", perl = TRUE)[[1]][[1]]
  if (cl$type %in% first_down_types && !identical(cl$team, pre$posteam) && grepl("pass incomplete", base, ignore.case = TRUE) && post$down == 1 && flag(p$first_down_penalty)) {
    alt <- pre
    alt$half_seconds_remaining <- post$half_seconds_remaining; alt$game_seconds_remaining <- post$game_seconds_remaining; alt$quarter_seconds_remaining <- post$quarter_seconds_remaining
    alt <- if (pre$down == 4) flip_state(alt) else { alt$down <- pre$down + 1; alt }
    return(list(actual = post, alternative = alt, clauses = clauses, assumption = "Observed incomplete pass stands without enforcement; this is not an estimate of a foul-free play."))
  }
  fail("alternative_requires_review")
}
