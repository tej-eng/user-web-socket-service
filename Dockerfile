# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install deps first
COPY package*.json ./

# Install all dependencies (not just production!)
# because prisma needs dev deps (prisma CLI) to generate the client
RUN npm install

# Copy rest of the code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Expose port (Render will set $PORT anyway, but good practice)
EXPOSE 10000

# Start server
CMD ["node", "index.js"]
