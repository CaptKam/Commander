# Use Node 22 Alpine for a lightweight, secure production image
FROM node:22-alpine

# Set the working directory
WORKDIR /app

# Set timezone to UTC (Critical for trading bot candle consistency)
RUN apk add --no-cache tzdata
ENV TZ=UTC

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install ALL dependencies (dev needed for vite build)
RUN npm ci --legacy-peer-deps

# Copy the rest of the application code
COPY . .

# Build the React dashboard
RUN npm run build

# Remove dev dependencies after build to shrink the image
RUN npm prune --omit=dev --legacy-peer-deps

# Expose the port for the Dashboard API (Web Service)
EXPOSE 3000

# Start command
CMD ["node", "--import", "tsx", "server/index.ts"]
