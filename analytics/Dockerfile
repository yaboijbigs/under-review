FROM rocker/r-ver:4.5.2
RUN apt-get update && apt-get install -y --no-install-recommends git libcurl4-openssl-dev libssl-dev libxml2-dev libfontconfig1-dev libharfbuzz-dev libfribidi-dev libfreetype6-dev libpng-dev libtiff5-dev libjpeg-dev libuv1-dev cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY analytics/restore.R analytics/renv.lock analytics/
RUN Rscript analytics/restore.R
COPY analytics analytics
ENV ANALYTICS_ROOT=/app/analytics OMP_NUM_THREADS=1
CMD ["Rscript", "analytics/tests/run.R"]
