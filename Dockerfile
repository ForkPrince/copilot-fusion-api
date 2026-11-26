FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/cli.js", "serve"]
