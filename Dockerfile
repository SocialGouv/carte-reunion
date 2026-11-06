FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Node 24 exécute le TypeScript directement (suppression des types) : pas d'étape de compilation.
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

CMD ["node", "src/server.ts"]
