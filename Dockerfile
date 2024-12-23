FROM node:16-alpine

RUN apk add --no-cache openssl1.1-compat

# add project files to /app
ADD ./ /app
WORKDIR /app

# install node dependencies
RUN npm install

EXPOSE 8080
