RARITY_VERSION <- "under-review-category-reference-v1"
opportunity_stratum <- function(n) if (n <= 0) "none" else if (n <= 2) as.character(n) else if (n <= 4) "3-4" else if (n <= 8) "5-8" else "9+"
rarity_key <- function(m) paste(m$category, m$name, m$unit, m$modelVersion, "complete", sep = "|")
rarity_opportunities <- function(peers) {
  ids <- unique(unlist(lapply(peers, `[[`, "playIds"), use.names = FALSE))
  if (length(ids) && peers[[1]]$category %in% c("fumble", "kicking")) length(ids) else sum(vapply(peers, function(x) x$coverage$eligible, numeric(1)))
}
reference_group <- function(key, records) {
  ids <- vapply(records, function(r) r$gameId, character(1)); n <- length(unique(ids))
  values <- vapply(records, function(r) r$value, numeric(1))
  seasons <- sort(unique(substr(ids, 1, 4)))
  list(key = key, gameCount = n, status = if (n >= 200) "eligible" else "insufficient_reference_games", minimumGames = 200L,
       referencePeriod = paste(range(as.integer(seasons)), collapse = "–"), maximumSeason = max(as.integer(seasons)),
       gameIds = as.list(ids), values = as.list(sort(values)),
       comparison = "This team's absolute residual versus each comparable game's largest absolute team residual; identical model, complete coverage and opportunity-count stratum. Direction remains in the signed metric; rarity is not intent.")
}
add_rarity <- function(metrics, game, model_dir) {
  path <- file.path(model_dir, "category-reference.json")
  reference <- if (file.exists(path)) jsonlite::read_json(path) else list(categories = list())
  checksum <- if (file.exists(path)) model_hash(path) else NULL
  keys <- vapply(metrics, rarity_key, character(1))
  for (i in seq_along(metrics)) {
    m <- metrics[[i]]; peers <- metrics[keys == keys[[i]]]
    eligible <- rarity_opportunities(peers)
    complete <- all(vapply(peers, function(x) x$status == "supported" && x$coverage$eligible == x$coverage$modeled, logical(1)))
    key <- paste(keys[[i]], opportunity_stratum(eligible), sep = "|")
    matches <- Filter(function(r) identical(r$key, key), reference$categories)
    ref <- if (length(matches) == 1L) matches[[1]] else NULL
    reason <- if (!complete || is.null(m$value) || m$coverage$eligible == 0) "incomplete_or_no_opportunities" else if (is.null(ref)) "comparable_reference_unavailable" else if (num(game$season) <= num(ref$maximumSeason)) "reference_not_chronologically_prior" else if (num(ref$gameCount) < 200) "insufficient_reference_games" else NULL
    percentile <- NULL
    if (is.null(reason)) {
      values <- unlist(ref$values); below <- sum(values < abs(m$value)); equal <- sum(values == abs(m$value)); above <- sum(values > abs(m$value))
      if (length(values) != ref$gameCount || any(!is.finite(values))) reason <- "invalid_reference_artifact"
      else if (min(below + equal, above + equal) < 5L) reason <- "insufficient_tail_support"
      else percentile <- round(100 * (below + equal / 2) / length(values))
    }
    metrics[[i]]$rarity <- list(percentile = percentile, status = if (is.null(percentile)) "unavailable" else "supported", reasonCode = reason,
      referencePeriod = ref$referencePeriod %||% NULL, gameCount = num(ref$gameCount, 0L), modelVersion = m$modelVersion,
      comparison = ref$comparison %||% "No comparable historical category reference. Direction remains in the signed metric.", referenceChecksum = checksum)
  }
  metrics
}
