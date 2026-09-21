root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
suppressPackageStartupMessages({ library(dplyr); library(tidyr); library(tibble) })
for (name in c("common", "states", "baselines", "rarity")) source(file.path(root, "R", paste0(name, ".R")))
evaluation <- jsonlite::read_json(file.path(root, "models/evaluation.json"))
input <- readRDS(file.path(root, "models", evaluation$models$fumble$inputSnapshot))
p <- input[which(input$season == 2024)[[1]], , drop = FALSE]
game <- list(id = p$game_id[[1]], season = 2024, homeTeam = p$home_team[[1]], awayTeam = p$away_team[[1]])
extract <- function(play) Filter(function(m) m$category == "fumble", baseline_metrics(play, game, file.path(root, "models")))
for (recovering in c(game$homeTeam, game$awayTeam)) {
  p$fumble_recovery_1_team <- recovering
  metrics <- extract(p)
  stopifnot(length(metrics) == 2L, abs(sum(vapply(metrics, `[[`, numeric(1), "value"))) < 1e-12)
  for (m in metrics) {
    stopifnot(if (m$team == recovering) m$value > 0 else m$value < 0,
      length(m$eventIds) == 1L, length(m$playIds) == 1L, m$coverage$eligible == 1L)
  }
  stopifnot(identical(metrics[[1]]$eventIds, metrics[[2]]$eventIds), rarity_opportunities(metrics) == 1L)
}
p$fumble <- 0
empty <- extract(p)
stopifnot(all(vapply(empty, function(m) length(m$eventIds) == 0L && length(m$playIds) == 0L && m$coverage$eligible == 0L, logical(1))))
message("Both recovery branches attribute equal and opposite team residuals and one shared event; zero opportunities have no orphan evidence IDs.")
