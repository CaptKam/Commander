# Use Node 22 Alpine for a lightweight, secure production image
FROM node:22-alpine

# Set the working directory
WORKDIR /app

# Set timezone to UTC (Critical for trading bot candle consistency)
RUN apk add --no-cache tzdata
ENV TZ=UTC

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Install tsx globally to run TypeScript files directly in production
RUN npm install -g tsx

# Expose the port for the Dashboard API (Web Service)
EXPOSE 3000

# Start command
CMD ["tsx", "server/index.ts"]
