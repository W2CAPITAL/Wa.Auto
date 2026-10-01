# Deploy gratuito no Northflank

Esta é a alternativa ao Render suspenso para o WA.Auto.

## Por que Northflank

O plano Developer Sandbox permite serviços gratuitos com compute always-on. Para o WA.Auto isso é importante porque a sessão Baileys usa WebSocket persistente e não deve depender de uma função serverless.

## Serviço

Crie um **Combined Service** a partir de:

- repositório: `W2CAPITAL/Wa.Auto`
- branch: `main`
- build: **Dockerfile**
- porta pública: `10000`
- protocolo: HTTP
- health check: `/api/health`
- plano: free / Sandbox

O Dockerfile já contém:

- Node 22;
- dependências de produção;
- `EXPOSE 10000`;
- healthcheck local;
- `npm start`.

O servidor usa `process.env.PORT` quando a plataforma fornecer outra porta.

## Variáveis

Copie os valores do ambiente seguro para o serviço Northflank:

```dotenv
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
WA_DB_SECRET=...
WA_MEMORY_LIMIT_MB=512
WA_MEMORY_PAUSE_MB=430
WA_MEMORY_RESUME_MB=360
WA_HISTORY_RETENTION_DAYS=30
WA_LEGAL_SEND_DELAY_MS=30000
```

Não coloque `WA_DB_SECRET` no GitHub.

Depois de o Northflank gerar o domínio público:

```dotenv
WA_PUBLIC_ORIGIN=https://SEU-DOMINIO-NORTHFLANK
```

## Troca do host sem alterar código

Depois do primeiro healthcheck verde:

1. no repositório `W2CAPITAL/Wa.Auto`, defina a variável de Actions `WA_AUTO_BASE_URL` com o novo domínio;
2. no projeto Vercel do SheetsPredict, troque `WA_AUTO_URL` para o mesmo domínio;
3. faça um novo deployment do SheetsPredict;
4. abra `/api/health` no domínio do WA.Auto e confirme `"ok": true`;
5. conecte novamente o WhatsApp por QR se a sessão restaurada não ficar pronta.

Os workflows `keep-warm.yml` e `process-monitor.yml` já usam `WA_AUTO_BASE_URL`, portanto não é necessário editar os YAMLs na migração.

## Persistência

O SQLite continua sendo apenas cache operacional. O estado persistente permanece no Supabase por `RemoteSnapshot`, então reinícios do container não devem apagar a carteira, filas ou credenciais de sessão já persistidas.

## Segurança

- não exponha `WA_DB_SECRET`;
- não use `SUPABASE_SERVICE_ROLE_KEY` aqui;
- mantenha envio MCP desativado até realmente necessário;
- valide o QR/pareamento antes de liberar campanhas;
- faça primeiro uma mensagem de teste.
