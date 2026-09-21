options(repos = c(CRAN = "https://cloud.r-project.org"), timeout = 600, Ncpus = 4L)
root <- Sys.getenv("ANALYTICS_ROOT", "analytics")
# Only bootstrap renv itself; every other dependency comes from the checked-in lock.
if (!requireNamespace("renv", quietly = TRUE) || as.character(packageVersion("renv")) != "1.2.4") {
  archive <- tempfile(fileext = ".tar.gz")
  urls <- c("https://cloud.r-project.org/src/contrib/renv_1.2.4.tar.gz", "https://cloud.r-project.org/src/contrib/Archive/renv/renv_1.2.4.tar.gz")
  downloaded <- FALSE
  for (url in urls) {
    status <- tryCatch(suppressWarnings(download.file(url, archive, mode = "wb", quiet = TRUE)), error = function(e) 1L)
    if (status == 0L) { downloaded <- TRUE; break }
  }
  if (!downloaded) stop("Pinned renv 1.2.4 source unavailable")
  install.packages(archive, repos = NULL, type = "source")
}
renv::restore(project = root, library = .libPaths()[[1]], lockfile = file.path(root, "renv.lock"), prompt = FALSE)
lock <- renv::lockfile_read(file.path(root, "renv.lock"))
for (name in names(lock$Packages)) {
  actual <- as.character(packageVersion(name)); expected <- lock$Packages[[name]]$Version
  if (package_version(actual) != package_version(expected)) stop("Dependency version mismatch: ", name, " expected ", expected, " found ", actual)
}
message("Installed package versions match the dependency lock.")
