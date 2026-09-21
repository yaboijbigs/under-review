#!/usr/bin/env Rscript
# Input: {gameId,revisionNumber,analysis}; one latest revision per canonical game.
# Usage: Rscript analytics/calibrate.R reports-directory output.json
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2)
root <- Sys.getenv("ANALYTICS_ROOT", "analytics"); source(file.path(root, "R/common.R")); source(file.path(root, "R/rarity.R"))
files <- list.files(args[[1]], pattern = "\\.json$", full.names = TRUE)
games <- list(); rejected <- list()
for (path in files) {
  report <- jsonlite::read_json(path, simplifyVector = FALSE)
  gid <- txt(report$gameId %||% report$game$id)
  revision <- num(report$revisionNumber %||% report$revision$number)
  analysis <- report$analysis %||% report$revision$analysis
  if (!grepl("^[0-9]{4}_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$", gid) || !is.finite(revision) || is.null(analysis$metrics)) {
    rejected[[length(rejected) + 1L]] <- list(file = basename(path), reason = "verified_game_id_revision_and_analysis_required"); next
  }
  previous <- games[[gid]]
  if (!is.null(previous) && revision == previous$revision && model_hash(path) != previous$checksum) stop("Conflicting same-game revision: ", gid)
  if (is.null(previous) || revision > previous$revision) games[[gid]] <- list(revision = revision, analysis = analysis, checksum = model_hash(path))
}
records <- list()
for (gid in names(games)) {
  metrics <- games[[gid]]$analysis$metrics
  keys <- vapply(metrics, rarity_key, character(1))
  for (base_key in unique(keys)) {
    peers <- metrics[keys == base_key]
    complete <- all(vapply(peers, function(m) m$status == "supported" && !is.null(m$value) && m$coverage$eligible == m$coverage$modeled, logical(1)))
    eligible <- rarity_opportunities(peers)
    if (!complete || eligible == 0) next
    key <- paste(base_key, opportunity_stratum(eligible), sep = "|")
    records[[key]][[gid]] <- list(gameId = gid, value = max(vapply(peers, function(m) abs(m$value), numeric(1))))
  }
}
out <- lapply(names(records), function(key) reference_group(key, records[[key]]))
write_json(list(schemaVersion = 1L, version = RARITY_VERSION, categories = out, rejected = rejected, overallPercentile = NULL, overallReason = "No held-out aggregate selection procedure has been validated."), args[[2]])
