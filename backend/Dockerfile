FROM node:alpine
COPY package.json package.json
RUN npm install
COPY . .
EXPOSE 8000
CMD [ "node", "server.js" ]
