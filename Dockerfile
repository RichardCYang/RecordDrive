FROM node:24.18.0-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node vendor/xz-compat-purejs ./vendor/xz-compat-purejs
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node views ./views
RUN mkdir -p /app/data/uploads && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 3000 3443

USER node
CMD ["npm", "start"]
