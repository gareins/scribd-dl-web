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

# Download and extract GitHub repository
RUN wget https://github.com/rkwyu/scribd-dl/archive/refs/heads/main.zip && \
    unzip main.zip && \
    rm main.zip && \
    mv scribd-dl-main scribd-dl

# Install npm dependencies
RUN cd scribd-dl && npm install

# Copy Python application file
COPY app.py .

# Expose port for Flask
EXPOSE 5000

# Run the Python application
CMD ["python3", "app.py"]
