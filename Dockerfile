FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/renderer ./dist/renderer

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    GITMANAGER_HOST=0.0.0.0 \
    GITMANAGER_PORT=4173 \
    GITMANAGER_USER_DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4173

CMD ["node", "dist/server/index.cjs"]
