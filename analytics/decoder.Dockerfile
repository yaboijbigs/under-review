# Incremental repair for an already-built analytics runtime. The main Dockerfile
# restores the same gsisdecoder version from renv.lock on a clean build.
FROM under-review-analytics:local
RUN Rscript -e "options(repos=c(CRAN='https://cloud.r-project.org')); remotes::install_version('gsisdecoder', version='0.0.1', upgrade='never'); stopifnot(as.character(packageVersion('gsisdecoder')) == '0.0.1')"
