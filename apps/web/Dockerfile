FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install

# Copy the rest of the app
COPY . .

# Expose port
EXPOSE 3000

# Start in dev mode
CMD ["pnpm", "dev"]
