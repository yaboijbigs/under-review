`%||%` <- function(x, y) if (is.null(x) || !length(x)) y else x
scalar <- function(x, default = NA) if (is.null(x) || !length(x)) default else x[[1]]
num <- function(x, default = NA_real_) { value <- suppressWarnings(as.numeric(scalar(x, default))); if (is.na(value)) default else value }
flag <- function(x) isTRUE(num(x, 0) == 1)
txt <- function(x, default = "") { value <- as.character(scalar(x, default)); if (is.na(value)) default else value }
rows_df <- function(rows) {
  if (is.data.frame(rows)) return(rows)
  if (!length(rows)) return(data.frame())
  # CSV-derived JSON can represent midfield as numeric 50 and other field sides
  # as team strings. Promote any mixed textual column before strict bind_rows.
  character_columns <- unique(unlist(lapply(rows, function(r) names(r)[vapply(r, is.character, logical(1))]), use.names = FALSE))
  dplyr::bind_rows(lapply(rows, function(r) {
    r <- lapply(r, function(x) if (is.null(x)) NA else if (length(x) == 1 && !is.list(x)) x else NA)
    for (name in intersect(names(r), character_columns)) r[[name]] <- as.character(r[[name]])
    as.data.frame(r, stringsAsFactors = FALSE)
  }))
}
one_row <- function(df, i) as.list(df[i, , drop = FALSE])
event_id <- function(game, play) paste0(game, ":", txt(play$play_id))
metric <- function(id, category, name, team, value = NULL, unit = "probability", status = "supported", reason = NULL,
                   event = NULL, play = NULL, assumptions = character(), model = "under-review-v1", eligible = 1L, modeled = 1L,
                   actual = NULL, alternative = NULL, details = NULL) {
  if (!is.null(value) && (!is.numeric(value) || length(value) != 1 || !is.finite(value))) { value <- NULL; status <- "unavailable"; reason <- "nonfinite_result" }
  list(id = id, category = category, name = name, team = team, value = value, unit = unit, status = status,
       reasonCode = reason, eventIds = as.list(event %||% character()), playIds = as.list(as.character(play %||% character())),
       assumptions = as.list(assumptions), modelVersion = model, coverage = list(eligible = eligible, modeled = if (is.null(value)) 0L else modeled),
       actualState = actual, alternativeState = alternative, details = details)
}
safe_model <- function(expr) tryCatch(expr, error = function(e) list(error = conditionMessage(e)))
require_columns <- function(df, cols) {
  missing <- setdiff(cols, names(df))
  if (length(missing)) stop("Missing required fields: ", paste(missing, collapse = ", "))
}
write_json <- function(value, path) jsonlite::write_json(value, path, auto_unbox = TRUE, na = "null", null = "null", digits = 15, pretty = TRUE)
model_hash <- function(path) digest::digest(file = path, algo = "sha256")
game_value <- function(game, camel, snake, default = NULL) game[[camel]] %||% game[[snake]] %||% default
