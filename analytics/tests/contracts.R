root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
source(file.path(root, "R/common.R"))
rows <- rows_df(list(list(play_id = 1L, side_of_field = "KC", penalty = 0), list(play_id = 2L, side_of_field = 50L, penalty = 1), list(play_id = 3L, side_of_field = NULL, penalty = NULL)))
stopifnot(identical(rows$side_of_field, c("KC", "50", NA_character_)), is.numeric(rows$play_id), is.na(rows$penalty[[3]]))
directory <- tempfile("category-revisions-"); dir.create(directory)
sample_metric <- metric("one", "kicking", "Kick residual", "SEA", 1, "points", model = "test-v1")
report <- list(gameId = "2026_01_NE_SEA", revisionNumber = 1L, analysis = list(metrics = list(sample_metric, sample_metric)))
write_json(report, file.path(directory, "revision-1.json"))
report$revisionNumber <- 2L; report$analysis$metrics[[1]]$value <- 2
write_json(report, file.path(directory, "revision-2.json"))
write_json(list(analysis = report$analysis), file.path(directory, "missing-id.json"))
output <- tempfile(fileext = ".json")
env <- new.env(parent = globalenv()); env$commandArgs <- function(trailingOnly = FALSE) c(directory, output)
sys.source(file.path(root, "calibrate.R"), env)
result <- jsonlite::read_json(output)
stopifnot(length(result$categories) == 1L, result$categories[[1]]$gameCount == 1L,
          result$categories[[1]]$status == "insufficient_reference_games", length(result$categories[[1]]$values) == 1L,
          length(result$rejected) == 1L)
real <- file.path(root, "tests/output-2026_01_NE_SEA.json")
if (file.exists(real)) {
  metrics <- jsonlite::read_json(real)$metrics
  opportunities <- function(name) sum(vapply(Filter(function(m) identical(m$name, name), metrics), function(m) m$coverage$eligible, numeric(1)))
  stopifnot(opportunities("Charted drops") == 57L, opportunities("QB-attributed sacks") == 5L, opportunities("Receiver-created receptions") == 57L)
}
message("JSON mixed-column, unique-game calibration and FTN opportunity contract checks passed.")
