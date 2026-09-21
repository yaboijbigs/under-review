root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
source(file.path(root, "R/common.R"))
dir.create(file.path(root, "models"), recursive = TRUE, showWarnings = FALSE)
options(nfl4th.keep_games = TRUE)
ns <- asNamespace("nfl4th")
for (name in c("fg_model", "two_pt_model", "punt_df")) saveRDS(get(name, envir = ns), file.path(root, "models", paste0(name, ".rds")), version = 3)
for (name in c("ep_model", "wp_model", "wp_model_spread")) saveRDS(getExportedValue("fastrmodels", name), file.path(root, "models", paste0("fastr_", name, ".rds")), version = 3)
paths <- file.path(root, "models", paste0(c("fd_model", "wp_model", "fg_model", "two_pt_model", "punt_df", "fastr_ep_model", "fastr_wp_model", "fastr_wp_model_spread"), ".rds"))
artifacts <- lapply(paths, function(path) list(file = basename(path), sha256 = model_hash(path), bytes = file.info(path)$size,
    source = if (basename(path) %in% c("fd_model.rds", "wp_model.rds")) paste0("https://github.com/nflverse/nfl4th/releases/download/model_archive/", basename(path)) else "Pinned R package data",
    trainingWindow = NULL, provenanceStatus = "upstream_training_cutoff_unverified"))
write_json(list(schemaVersion = 1L, modelVersion = "under-review-nfl4th-2026-v1", upstream = "nfl4th 1.0.7; nflfastR 6.0.0; fastrmodels 2.1.0", artifacts = artifacts), file.path(root, "models/manifest.json"))
options(repos = c(CRAN = "https://cloud.r-project.org"))
renv::snapshot(project = root, lockfile = file.path(root, "renv.lock"), type = "all", prompt = FALSE)
