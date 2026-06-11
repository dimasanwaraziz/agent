FROM node:24-slim
WORKDIR /app

# Install basic python/build dependencies if native compilation is triggered, though prebuilds should work
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000
CMD ["npm", "start"]
