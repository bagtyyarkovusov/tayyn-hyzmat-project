FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile && pnpm exec prisma generate
COPY src ./src
COPY tsconfig.json ./
RUN pnpm run build
ENV NODE_ENV=production PORT=4000
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
