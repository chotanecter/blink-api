FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Expose ports: HTTP+WS (PORT), MQTT TCP
EXPOSE 3000 1883

CMD ["bun", "run", "src/index.ts"]
