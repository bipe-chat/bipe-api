FROM node:24.18.1-alpine3.24 AS build
WORKDIR /app
RUN npm install -g pnpm@10.26.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24.18.1-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
