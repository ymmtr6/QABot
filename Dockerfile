FROM node:12-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production
COPY images ./images
COPY views ./views
COPY config ./config
COPY tmp ./tmp
COPY *.js ./
CMD [ "npm", "start" ]
