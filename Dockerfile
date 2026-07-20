FROM node:24.18.0-alpine

WORKDIR /app

# 7z previews call only the 7-Zip metadata listing command; no archive data is extracted.
RUN apk add --no-cache 7zip

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data/uploads && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 3000 3443

USER node
CMD ["npm", "start"]
