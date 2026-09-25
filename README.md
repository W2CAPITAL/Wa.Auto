# WA.Auto

Automação local de mensagens para clientes a partir de Excel e CSV. Gratuito, sem CNPJ e sem chave de API paga. Conexão pelo QR Code do WhatsApp.

> Implementação em andamento nesta primeira entrega. O backend de importação, campanhas, fila persistente e conexão WhatsApp já está incluído. Interface, testes e inicializador para Windows serão adicionados nos próximos commits desta implementação.

Requisitos: Node.js 24, um computador ligado e internet durante os envios.

```sh
npm ci
npm start
```

Acesse `http://127.0.0.1:3210`. Os dados são armazenados na pasta local `data/`, excluída do Git. A integração usa `whatsapp-web.js`, não é oficial e pode sofrer mudanças ou bloqueios pelo WhatsApp.
