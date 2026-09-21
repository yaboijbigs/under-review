options(repos = c(CRAN = "https://cloud.r-project.org"), Ncpus = max(1L, min(4L, parallel::detectCores())), timeout = 600)
install.packages(c("remotes", "renv", "jsonlite", "digest", "dplyr", "tidyr", "tibble", "mgcv", "testthat", "MASS"))
# Explicit release pins; remotes resolves dependencies once and freeze.R records every version.
pins <- c(nflreadr = "1.5.0", fastrmodels = "2.1.0", nflfastR = "6.0.0", nfl4th = "1.0.7", gsisdecoder = "0.0.1")
for (pkg in names(pins)) remotes::install_version(pkg, version = pins[[pkg]], upgrade = "never", dependencies = NA)
for (pkg in names(pins)) stopifnot(as.character(packageVersion(pkg)) == pins[[pkg]])
