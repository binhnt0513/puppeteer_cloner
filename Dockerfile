FROM node:22-slim

# Cài các thư viện hệ thống để Chrome của Puppeteer chạy được
RUN apt-get update && apt-get install -y \
    wget gnupg unzip \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrender1 \
    libxtst6 libglib2.0-0 libnss3 libnspr4 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
    libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
    libgtk-3-0 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 libxrandr2 libxss1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy file khai báo dependencies (giữ cache layer tốt)
COPY package.json pnpm-lock.yaml* ./

# Cài corepack và dependencies
RUN corepack enable && pnpm install && pnpm exec puppeteer browsers install chrome@141.0.7362.0

ENV PUPPETEER_EXECUTABLE_PATH=/root/.cache/puppeteer/chrome/linux-141.0.7362.0/chrome-linux64/chrome


# Copy toàn bộ source code (để build image đầy đủ, còn dev thì sẽ mount volume)
COPY . .

# Mặc định vào shell (container chỉ để môi trường sẵn sàng)
CMD ["bash"]

#CMD ["bash"]