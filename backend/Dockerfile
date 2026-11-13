# Coco Legal backend: Express API plus LibreOffice for DOCX/XLSX/PPTX → PDF.
#
#   docker build -t coco-legal-backend ./backend
#
# Development dependencies stay installed on purpose: `npm run migrate` runs
# through tsx, so the same image can apply migrations:
#   docker compose run --rm backend npm run migrate
FROM node:20-bookworm-slim

# Liberation fonts are the metric-compatible stand-ins for Times New Roman and
# Arial that generated documents use; DejaVu covers the remaining glyphs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc libreoffice-impress \
        fontconfig fonts-liberation fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start"]
