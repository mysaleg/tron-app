FROM node:18-alpine
WORKDIR /app
RUN npm cache clean --force
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8000
CMD ["node", "server.js"]
