FROM ubuntu:latest

# Create and set working directory
WORKDIR /app

USER root

# Install packages
RUN apt update
RUN apt install -y \
  python3-flask \
  wget unzip \
  nodejs npm 

# cleanup apt
RUN rm -rf /var/lib/apt/lists/*
RUN apt autoremove -y && apt clean -y

# Download and extract GitHub repository
RUN wget https://github.com/rkwyu/scribd-dl/archive/refs/heads/main.zip && \
    unzip main.zip && \
    rm main.zip && \
    mv scribd-dl-main scribd-dl

# Patch code
COPY patch.py ./
RUN python3 patch.py scribd-dl
RUN rm patch.py

# Install npm dependencies
RUN cd scribd-dl && npm install

# cleanup
RUN apt remove -y wget unzip
RUN apt-get clean
RUN cd scribd-dl && npm dedupe

# Copy Python application file
COPY app.py .
COPY background.py .
COPY templates/index.html templates/index.html

# Expose port for Flask
EXPOSE 5000

# Run the Python application
CMD ["python3", "app.py"]
