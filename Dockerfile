# Simple Dockerfile for buzzdrop Flask app
FROM python:3.15-rc-alpine3.22

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Set work directory
WORKDIR /app

# Zone data, so TZ works (the E2E profile sets one). The app stores and
# compares UTC and doesn't depend on it.
RUN apk add --no-cache tzdata

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project files
COPY . .

# Create uploads directory (if not mounted)
RUN mkdir -p uploads

# Expose Flask default port
EXPOSE 5000

# Set environment variables for Flask
ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0

# Entrypoint: run Flask app
CMD ["flask", "run"]
