FROM node:24.18.0-alpine

WORKDIR /app

# Native archive parsing is intentionally absent from the default image.
# Opt in only in a separately sandboxed deployment and keep 7-Zip patched.
ARG RECORDDRIVE_INSTALL_7ZIP=false
RUN if [ "$RECORDDRIVE_INSTALL_7ZIP" = "true" ]; then apk add --no-cache 7zip; fi

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data/uploads && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 3000 3443

USER node
CMD ["npm", "start"]
