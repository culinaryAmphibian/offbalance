# Vite dev server proxying /api to the server container, as startup.py runs it
FROM node:24-bookworm-slim

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
# playwright is only for the browser tests
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
COPY frontend/ ./

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
