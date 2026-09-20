FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3003

# No migrate step: this service owns no schema. Bookings go through beauta-api.
CMD ["node", "dist/server.js"]
