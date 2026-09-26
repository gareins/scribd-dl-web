FROM node:20-bookworm-slim

# Create and set working directory
WORKDIR /app

USER root

# Install packages (node/npm already provided by base image)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  python3 \
  python3-flask \
  gunicorn \
  && rm -rf /var/lib/apt/lists/*

# Use the vendored local copy of scribd-dl (git submodule) instead of downloading a zip
COPY scribd-dl-all/ ./scribd-dl/

# Patch code
COPY patch.py ./
RUN python3 patch.py scribd-dl
RUN rm patch.py

# Install npm dependencies, skipping puppeteer's bundled Chrome (app connects to the browser service) and omitting dev deps
RUN cd scribd-dl && PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev

# Copy Python application file
COPY app.py .
COPY background.py .
COPY templates/index.html templates/index.html

# Expose port for Flask
EXPOSE 5000

# Run the Python application
# CMD ["python3", "app.py"] # Debug version
CMD ["gunicorn"  , "-b", "0.0.0.0:5000", "app:app"]