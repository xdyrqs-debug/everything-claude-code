# Glassboard co-op relay — forwards end-to-end encrypted messages between peers.
# Build from apps/glassboard:  docker build -f relay.Dockerfile -t glassboard-relay .
# Run:                         docker run -p 47900:47900 glassboard-relay
# Put it behind HTTPS (Caddy, nginx, a PaaS) and use wss://your-host in Glassboard.
FROM node:22-alpine
WORKDIR /app
COPY src/coop/relay.js ./relay.js
ENV PORT=47900
EXPOSE 47900
USER node
CMD ["node", "relay.js"]
