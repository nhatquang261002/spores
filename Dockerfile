# The open-ended supervisor (agents/src/auto.ts) as one always-on worker:
# the keeper closes epochs and the agents trade on router4, testnet only.
# No web server, no ports. Keys come in as environment variables, the same
# names as in .env (set them on the platform, never bake them into the image).
#   docker build -t spores-auto . && docker run --rm --env-file .env -e AUTO_HOLD_ON_STOP=1 spores-auto
FROM node:24-slim
WORKDIR /app
COPY agents/package.json agents/package-lock.json agents/
RUN cd agents && npm ci --omit=dev --silent
COPY agents agents
COPY outside outside
ENV NODE_ENV=production AUTO_HOLD_ON_STOP=1
CMD ["node", "agents/src/auto.ts"]
