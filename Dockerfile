FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY . .

ENV PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>{if(j.ok!==true)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm","start"]
