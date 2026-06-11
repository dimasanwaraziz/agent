FROM node:24-slim
WORKDIR /app

# Install basic compile tools plus SSH clients to support remote execution capabilities
RUN apt-get update && apt-get install -y python3 make g++ openssh-client sshpass && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000
CMD ["npm", "start"]
