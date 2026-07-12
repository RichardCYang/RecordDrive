FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data/uploads && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 3000 3443

USER node
CMD ["npm", "start"]
