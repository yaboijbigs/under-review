#!/usr/bin/env Rscript
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2) stop("Usage: Rscript analytics/run.R request.json response.json")
script_arg <- grep("^--file=", commandArgs(FALSE), value = TRUE)[[1]]
root <- Sys.getenv("ANALYTICS_ROOT", dirname(normalizePath(sub("^--file=", "", script_arg))))
suppressPackageStartupMessages({ library(jsonlite); library(dplyr); library(tidyr); library(tibble) })
for (name in c("common", "states", "fourth", "baselines", "engine")) source(file.path(root, "R", paste0(name, ".R")))
exit_status <- 0L
result <- tryCatch({
  request <- jsonlite::read_json(args[[1]], simplifyVector = FALSE)
  action <- request$action %||% request$operation
  if (identical(action, "build_pbp")) {
    if (!grepl("^[0-9]{4}_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$", txt(request$gameId))) stop("Invalid game ID")
    if (is.null(request$rawDirectory)) stop("Immutable rawDirectory is required")
    raw_dir <- normalizePath(request$rawDirectory, mustWork = TRUE)
    pbp <- nflfastR::build_nflfastR_pbp(txt(request$gameId), dir = raw_dir, decode = TRUE, rules = FALSE)
    list(schemaVersion = 1L, plays = lapply(seq_len(nrow(pbp)), function(i) one_row(pbp, i)))
  } else if (identical(action, "analyze")) analyze_game(request, root)
  else if (action %in% c("train", "calibrate", "evaluate", "percentiles")) {
    invoke <- function(script, values) {
      env <- new.env(parent = globalenv())
      env$commandArgs <- function(trailingOnly = FALSE) if (trailingOnly) as.character(values) else base::commandArgs(FALSE)
      sys.source(file.path(root, script), envir = env)
    }
    if (action %in% c("train", "calibrate")) {
      invoke("train.R", c(num(request$trainStart, 2015), num(request$trainEnd, 2022), num(request$calibrationSeason, 2023), num(request$testStart, 2024), num(request$testEnd, 2025)))
      jsonlite::read_json(file.path(root, "models/evaluation.json"))
    } else if (action == "evaluate") {
      if (txt(request$kind, "coaching") == "coaching") { invoke("evaluate_coaching.R", unlist(request$seasons %||% list(2025, 2026))); jsonlite::read_json(file.path(root, "models/coaching-evaluation.json")) }
      else jsonlite::read_json(file.path(root, "models/evaluation.json"))
    } else {
      path <- file.path(root, "models/category-reference.json")
      if (txt(request$kind) == "baseline_reference") invoke("reference_baselines.R", character()) else {
        if (is.null(request$reportsDirectory)) stop("reportsDirectory is required")
        invoke("calibrate.R", c(request$reportsDirectory, path))
      }
      jsonlite::read_json(path)
    }
  } else stop("Unsupported analytics action")
}, error = function(e) { exit_status <<- 1L; list(schemaVersion = 1L, error = list(code = "analytics_error", message = conditionMessage(e))) })
write_json(result, args[[2]])
quit(status = exit_status)
