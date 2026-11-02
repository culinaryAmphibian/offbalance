# OffBalance web UI (Vite dev server, proxying /api to the HTTPS server).
#   docker build -t offbalance-frontend frontend
#   docker run --rm -p 5173:5173 \
#     -e API_PROXY_TARGET=https://server:5000 \
#     -v offbalance-tls:/certs:ro offbalance-frontend
# API_CA_FILE must point at the server's certificate for the proxy to trust it.
FROM node:24-slim

WORKDIR /app/frontend
COPY package.json package-lock.json ./
# playwright is only for the browser tests; don't fetch browsers
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY . .

ENV VITE_API_MODE=api \
    VITE_API_BASE_URL=/api \
    API_PROXY_TARGET=https://server:5000 \
    API_CA_FILE=/certs/cert.pem

EXPOSE 5173
# the npm "dev" script binds 127.0.0.1, which is unreachable from outside the container
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]
