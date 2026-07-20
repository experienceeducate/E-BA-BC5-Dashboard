# Stage 1: Build the Vite app
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:stable-alpine
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf && mkdir -p /etc/nginx/snippets
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf            /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
