FROM node:12-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production
COPY images ./images
COPY views ./views
COPY *.js ./
CMD [ "npm", "start" ]
