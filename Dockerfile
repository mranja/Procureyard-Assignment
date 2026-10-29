FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native sqlite / python if needed
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8000

ENV PORT=8000
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
