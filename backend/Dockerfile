FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund && npx prisma generate
COPY src ./src
COPY tsconfig.json ./
RUN npm run build
ENV NODE_ENV=production PORT=4000
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
