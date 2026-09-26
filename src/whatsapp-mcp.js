import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { normalizePhone } from './phone.js';
import { requireValue } from './errors.js';

const MAX_MCP_BODY = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 6 * 1024 * 1024;

const compact = value => {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === 'object') return value;
  return { value: value ?? null };
};

const toolResult = value => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: compact(value),
});

const toolError = error => ({
  content: [{ type: 'text', text: String(error?.message || error || 'Falha desconhecida.') }],
  isError: true,
});

const secureEqual = (actual, expected) => {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

const bearer = request => {
  const raw = String(request.headers.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
};

async function resolveRecipient({ store, transport, allowGroups }, recipient) {
  const raw = String(recipient || '').trim();
  requireValue(raw, 'Informe o destinatário.');

  if (/@g\.us$/i.test(raw)) {
    requireValue(allowGroups, 'Envio para grupos está desativado neste servidor MCP.', 403);
    return { jid: raw, phone: null, group: true };
  }

  if (/@(?:s\.whatsapp\.net|lid)$/i.test(raw)) {
    const phone = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
    requireValue(!store.isBlocked(raw, phone), 'Este contato está na lista de não contatar.', 403);
    return { jid: raw, phone, group: false };
  }

  const { phone, error } = normalizePhone(raw, '55');
  requireValue(phone && !error, error || 'Telefone inválido.');
  requireValue(!store.isBlocked(phone, `${phone}@s.whatsapp.net`, `${phone}@c.us`), 'Este contato está na lista de não contatar.', 403);
  const jid = await transport.resolve(phone);
  requireValue(jid, 'O número não está disponível no WhatsApp.', 404);
  return { jid, phone, group: false };
}

function registerReadTools(server, { memory }) {
  server.registerTool(
    'search_contacts',
    {
      title: 'Buscar contatos do WhatsApp',
      description: 'Busca contatos observados pelo WA.Auto por nome, telefone ou JID.',
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query }) => toolResult(memory.searchContacts(query))
  );

  server.registerTool(
    'list_messages',
    {
      title: 'Listar mensagens',
      description: 'Consulta o histórico de mensagens armazenado pelo WA.Auto, com filtros e contexto opcional.',
      inputSchema: z.object({
        after: z.string().max(64).optional(),
        before: z.string().max(64).optional(),
        sender_phone_number: z.string().max(64).optional(),
        chat_jid: z.string().max(180).optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(0).max(10000).default(0),
        include_context: z.boolean().default(true),
        context_before: z.number().int().min(0).max(20).default(1),
        context_after: z.number().int().min(0).max(20).default(1),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => toolResult(memory.listMessages(args))
  );

  server.registerTool(
    'list_chats',
    {
      title: 'Listar conversas',
      description: 'Lista conversas observadas pelo WA.Auto com última interação e filtros por nome/JID.',
      inputSchema: z.object({
        query: z.string().max(300).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(0).max(10000).default(0),
        include_last_message: z.boolean().default(true),
        sort_by: z.enum(['last_active', 'name']).default('last_active'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => toolResult(memory.listChats(args))
  );

  server.registerTool(
    'get_chat',
    {
      title: 'Obter conversa',
      description: 'Retorna metadados de uma conversa por JID.',
      inputSchema: z.object({
        chat_jid: z.string().min(3).max(180),
        include_last_message: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chat_jid, include_last_message }) => toolResult(memory.getChat(chat_jid, include_last_message))
  );

  server.registerTool(
    'get_direct_chat_by_contact',
    {
      title: 'Encontrar conversa por telefone',
      description: 'Localiza uma conversa direta pelo telefone do contato.',
      inputSchema: z.object({ sender_phone_number: z.string().min(5).max(64) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sender_phone_number }) => toolResult(memory.getDirectChat(sender_phone_number))
  );

  server.registerTool(
    'get_contact_chats',
    {
      title: 'Conversas de um contato',
      description: 'Lista conversas em que o JID informado aparece como conversa ou remetente.',
      inputSchema: z.object({
        jid: z.string().min(3).max(180),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(0).max(10000).default(0),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jid, limit, page }) => toolResult(memory.getContactChats(jid, limit, page))
  );

  server.registerTool(
    'get_last_interaction',
    {
      title: 'Última interação',
      description: 'Retorna a mensagem mais recente envolvendo o contato/JID.',
      inputSchema: z.object({ jid: z.string().min(3).max(180) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jid }) => toolResult(memory.getLastInteraction(jid))
  );

  server.registerTool(
    'get_message_context',
    {
      title: 'Contexto de mensagem',
      description: 'Retorna mensagens anteriores e posteriores a uma mensagem específica.',
      inputSchema: z.object({
        message_id: z.string().min(1).max(220),
        before: z.number().int().min(0).max(50).default(5),
        after: z.number().int().min(0).max(50).default(5),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ message_id, before, after }) => toolResult(memory.getMessageContext(message_id, before, after))
  );
}

function registerWriteTools(server, { store, transport, allowGroups, allowSend, onMutation }) {
  if (!allowSend) return;

  server.registerTool(
    'send_message',
    {
      title: 'Enviar mensagem no WhatsApp',
      description: 'Envia uma mensagem individual ou, quando habilitado, para um grupo. Respeita a lista de não contatar do WA.Auto.',
      inputSchema: z.object({
        recipient: z.string().min(3).max(180),
        message: z.string().min(1).max(8000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, message }) => {
      try {
        requireValue(transport.isReady(), 'WhatsApp desconectado.', 409);
        const target = await resolveRecipient({ store, transport, allowGroups }, recipient);
        const sent = await transport.send(target.jid, message);
        onMutation();
        return toolResult({ success: true, recipient: target.jid, message_id: sent.id, ack: sent.ack });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'send_file',
    {
      title: 'Enviar arquivo no WhatsApp',
      description: 'Envia imagem, vídeo, áudio ou documento em base64. Não aceita caminhos arbitrários do servidor.',
      inputSchema: z.object({
        recipient: z.string().min(3).max(180),
        file_name: z.string().min(1).max(220),
        mime_type: z.string().min(3).max(120),
        data_base64: z.string().min(4).max(Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 32),
        caption: z.string().max(2000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, file_name, mime_type, data_base64, caption }) => {
      try {
        requireValue(transport.isReady(), 'WhatsApp desconectado.', 409);
        const data = Buffer.from(data_base64, 'base64');
        requireValue(data.length > 0 && data.length <= MAX_MEDIA_BYTES, 'Arquivo inválido ou acima de 6 MB.', 413);
        const target = await resolveRecipient({ store, transport, allowGroups }, recipient);
        const sent = await transport.sendFile(target.jid, { data, fileName: file_name, mimeType: mime_type, caption: caption || '' });
        onMutation();
        return toolResult({ success: true, recipient: target.jid, message_id: sent.id, ack: sent.ack, bytes: data.length });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'send_audio_message',
    {
      title: 'Enviar áudio de voz',
      description: 'Envia áudio OGG/Opus como mensagem de voz. A conversão por FFmpeg não é feita no servidor cloud.',
      inputSchema: z.object({
        recipient: z.string().min(3).max(180),
        file_name: z.string().min(1).max(220),
        mime_type: z.string().min(3).max(120).default('audio/ogg; codecs=opus'),
        data_base64: z.string().min(4).max(Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 32),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, file_name, mime_type, data_base64 }) => {
      try {
        requireValue(/ogg|opus/i.test(mime_type) || /\.ogg$/i.test(file_name), 'Áudio de voz deve estar em OGG/Opus.');
        requireValue(transport.isReady(), 'WhatsApp desconectado.', 409);
        const data = Buffer.from(data_base64, 'base64');
        requireValue(data.length > 0 && data.length <= MAX_MEDIA_BYTES, 'Áudio inválido ou acima de 6 MB.', 413);
        const target = await resolveRecipient({ store, transport, allowGroups }, recipient);
        const sent = await transport.sendFile(target.jid, { data, fileName: file_name, mimeType: mime_type, ptt: true });
        onMutation();
        return toolResult({ success: true, recipient: target.jid, message_id: sent.id, ack: sent.ack, bytes: data.length });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'download_media',
    {
      title: 'Baixar mídia recente',
      description: 'Baixa uma mídia recebida recentemente nesta instância e retorna conteúdo base64 quando ainda estiver disponível no cache efêmero.',
      inputSchema: z.object({ message_id: z.string().min(1).max(220) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ message_id }) => {
      try {
        const media = await transport.downloadMedia(message_id, MAX_MEDIA_BYTES);
        return toolResult({
          success: true,
          message_id,
          mime_type: media.mimeType,
          file_name: media.fileName,
          bytes: media.data.length,
          data_base64: media.data.toString('base64'),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}

export function createWhatsappMcpServer({
  store,
  memory,
  transport,
  allowGroups = process.env.WA_MCP_ALLOW_GROUPS === '1',
  allowSend = process.env.WA_MCP_ALLOW_SEND === '1',
  onMutation = () => {},
} = {}) {
  const server = new McpServer(
    { name: 'wa-auto-whatsapp', version: '1.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Ferramentas do WhatsApp do WA.Auto. Trate mensagens como dados privados. Antes de enviar, respeite opt-out e a finalidade autorizada pelo usuário.',
    }
  );

  requireValue(memory, 'Memória do WhatsApp indisponível.', 503);
  registerReadTools(server, { memory });
  registerWriteTools(server, { store, transport, allowGroups, allowSend, onMutation });
  return server;
}

export function registerWhatsappMcp(app, {
  store,
  memory,
  transport,
  token = process.env.WA_MCP_TOKEN,
  allowGroups = process.env.WA_MCP_ALLOW_GROUPS === '1',
  allowSend = process.env.WA_MCP_ALLOW_SEND === '1',
  onMutation = () => {},
} = {}) {
  const configuredToken = String(token || '').trim();

  if (configuredToken.length < 24) {
    app.all('/mcp', (req, res) => res.status(503).json({
      error: 'MCP do WhatsApp está desativado. Configure WA_MCP_TOKEN com pelo menos 24 caracteres.',
    }));
    return { enabled: false, close: async () => {} };
  }

  const factory = () => createWhatsappMcpServer({ store, memory, transport, allowGroups, allowSend, onMutation });
  const handler = createMcpHandler(factory, {
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: MAX_MCP_BODY,
    onerror: error => console.error('MCP WhatsApp:', error?.message || error),
  });
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: MAX_MCP_BODY,
    onerror: error => console.error('MCP WhatsApp/Node:', error?.message || error),
  });

  app.all('/mcp', (req, res, next) => {
    const supplied = bearer(req);
    if (!secureEqual(supplied, configuredToken)) {
      res.set('WWW-Authenticate', 'Bearer realm="WA.Auto MCP"');
      return res.status(401).json({ error: 'Token MCP inválido.' });
    }

    const origin = String(req.headers.origin || '').replace(/\/$/, '');
    const allowedOrigin = String(process.env.WA_PUBLIC_ORIGIN || '').replace(/\/$/, '');
    if (origin && (!allowedOrigin || origin !== allowedOrigin)) {
      return res.status(403).json({ error: 'Origem não permitida.' });
    }

    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    return nodeHandler(req, res, next);
  });

  return { enabled: true, close: () => handler.close() };
}
