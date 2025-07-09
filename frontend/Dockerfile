FROM node:20-alpine as build
WORKDIR /app
COPY . .
RUN npm install && run npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY ../nginx/default.conf etc/nginx/conf.d/default.conf
