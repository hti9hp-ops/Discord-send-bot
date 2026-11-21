const http = require('http');
const { Pool } = require('pg');
const {
  Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  AttachmentBuilder, ChannelType, PermissionFlagsBits, MessageFlags, REST, Routes,
  SlashCommandBuilder
} = require('discord.js');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CONFIG_URL = process.env.CONFIG_URL || 'https://script.google.com/macros/s/AKfycbwdjcX1Kty8opa0CgZzYcSRqdJIO8fr4-wHbeCyMuEzzjK1Z5OYpryIeMyOsYr7acZTFw/exec';
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN Railway variable');
if (!GUILD_ID) throw new Error('Missing GUILD_ID Railway variable');
if (!CONFIG_URL) throw new Error('Missing CONFIG_URL Railway variable');
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL. Add PostgreSQL to this project.');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

let botReady = false;
const server = http.createServer((_req, res) => {
  const status = botReady ? 200 : 503;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: botReady, service: 'GAME HUB Discord Bot' }));
});
server.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

let cachedConfig = null;
let lastPanelSignature = '';
let lastPanelMessageIds = [];
const actionLocks = new Set();

function ephemeralReply(payload) {
  const { ephemeral, flags, ...rest } = payload || {};
  return {
    ...rest,
    flags: (flags ?? 0) | MessageFlags.Ephemeral
  };
}

function sanitizeSnowflake(val) {
  const s = String(val ?? '').trim();
  return /^\d{15,25}$/.test(s) ? s : '';
}

function sanitizeSnowflakeArray(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(sanitizeSnowflake).filter(Boolean))];
}

function normalizeTicketType(rawType) {
  const t = rawType && typeof rawType === 'object' ? rawType : {};
  const escalateEnabled = Boolean(
    t.escalateToOwnerEnabled ??
    t.allowOwnerEscalation ??
    t.escalateEnabled ??
    false
  );

  return {
    ...t,
    id: String(t.id || ''),
    sectionTitle: String(t.sectionTitle || t.name || 'شكوى'),
    sectionDescription: String(t.sectionDescription || ''),
    buttonLabel: String(t.buttonLabel || t.sectionTitle || 'فتح شكوى'),
    buttonStyle: String(t.buttonStyle || 'Primary'),
    defaultPriority: String(t.defaultPriority || 'عادية'),
    categoryId: sanitizeSnowflake(t.categoryId),
    allowedRoleIds: sanitizeSnowflakeArray(t.allowedRoleIds),
    staffRoleIds: sanitizeSnowflakeArray(t.staffRoleIds),
    fields: Array.isArray(t.fields) ? t.fields : [],
    evidenceNote: String(t.evidenceNote || ''),
    escalateToOwnerEnabled: escalateEnabled,
    ownerRoleId: sanitizeSnowflake(t.ownerRoleId || t.ownerEscalationRoleId),
    ownerCategoryId: sanitizeSnowflake(t.ownerCategoryId || t.ownerEscalationCategoryId)
  };
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    ...cfg,
    panelChannelId: sanitizeSnowflake(cfg.panelChannelId),
    logChannelId: sanitizeSnowflake(cfg.logChannelId),
    statsChannelId: sanitizeSnowflake(cfg.statsChannelId || cfg.statisticsChannelId),
    welcomeChannelId: sanitizeSnowflake(cfg.welcomeChannelId),
    goodbyeChannelId: sanitizeSnowflake(cfg.goodbyeChannelId),
    ownerEscalationRoleId: sanitizeSnowflake(cfg.ownerEscalationRoleId || cfg.ownerRoleId),
    ownerEscalationCategoryId: sanitizeSnowflake(cfg.ownerEscalationCategoryId || cfg.ownerCategoryId),
    allowMultipleTicketsPerUser: Boolean(cfg.allowMultipleTicketsPerUser),
    ticketTypes: Array.isArray(cfg.ticketTypes) ? cfg.ticketTypes.map(normalizeTicketType) : []
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runWithLock(lockKey, fn) {
  if (actionLocks.has(lockKey)) return { locked: true };
  actionLocks.add(lockKey);
  try {
    const result = await fn();
    return { locked: false, result };
  } finally {
    actionLocks.delete(lockKey);
  }
}

function mapButtonStyleNumber(styleName) {
  return ({
    Primary: 1,
    Secondary: 2,
    Success: 3,
    Danger: 4
  })[styleName] || 1;
}

function mapButtonStyle(styleName) {
  return ({
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger,
    Secondary: ButtonStyle.Secondary,
    Primary: ButtonStyle.Primary
  })[styleName] || ButtonStyle.Primary;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>()]+/gi);
  return matches ? [...new Set(matches)] : [];
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ar-IQ', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatText(template, member, guild) {
  return (template || '')
    .replace(/\{user\}/g, member ? `<@${member.id}>` : '')
    .replace(/\{tag\}/g, member?.user?.tag || member?.tag || '')
    .replace(/\{username\}/g, member?.user?.username || '')
    .replace(/\{server\}/g, guild?.name || '')
    .replace(/\{count\}/g, String(guild?.memberCount || 0));
}

function serializeMessage(msg) {
  const attachments = msg.attachments
    ? [...msg.attachments.values()].map(a => ({
        url: a.url,
        name: a.name || 'attachment',
        contentType: a.contentType || '',
        size: a.size || null
      }))
    : [];

  return {
    id: msg.id,
    authorTag: msg.author?.tag || msg.member?.user?.tag || 'مستخدم غير معروف',
    authorId: msg.author?.id || 'غير معروف',
    isBot: Boolean(msg.author?.bot),
    content: msg.content || '',
    createdAt: msg.createdTimestamp || Date.now(),
    attachments,
    links: extractUrls(msg.content || '')
  };
}

async function generateNextTicketNumber(db) {
  const res = await db.query('SELECT ticket_number FROM tickets');
  let maxNum = 123;

  for (const row of res.rows) {
    const digitsOnly = String(row.ticket_number ?? '').replace(/\D+/g, '');
    if (digitsOnly) {
      const parsed = Number(digitsOnly);
      if (Number.isSafeInteger(parsed) && parsed > maxNum) {
        maxNum = parsed;
      }
    }
  }

  for (let i = 1; i <= 500; i++) {
    const candidate = String(maxNum + i).padStart(6, '0');
    const exists = await db.query(
      'SELECT 1 FROM tickets WHERE ticket_number = $1 LIMIT 1',
      [candidate]
    );
    if (!exists.rowCount) {
      return candidate;
    }
  }

  return `${Date.now()}`.slice(-6).padStart(6, '0');
}

async function initDatabase() {
  const clientDb = await pool.connect();
  try {
    await clientDb.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        ticket_number TEXT NOT NULL UNIQUE,
        user_id TEXT,
        user_tag TEXT,
        opener_id TEXT NOT NULL,
        opener_tag TEXT NOT NULL,
        type_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        answers JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'open',
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        closed_by_id TEXT,
        closed_by_tag TEXT,
        close_reason TEXT,
        claimed_by_id TEXT,
        claimed_by_tag TEXT,
        escalated_to_owner BOOLEAN NOT NULL DEFAULT FALSE,
        escalated_at TIMESTAMPTZ,
        escalated_by_id TEXT,
        escalated_by_tag TEXT
      );

      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE tickets ALTER COLUMN user_id DROP NOT NULL;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS user_tag TEXT;
      ALTER TABLE tickets ALTER COLUMN user_tag DROP NOT NULL;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_number TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS opener_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS opener_tag TEXT NOT NULL DEFAULT '';
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS type_config JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by_id TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by_tag TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS close_reason TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by_id TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by_tag TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_to_owner BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_by_id TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_by_tag TEXT;

      CREATE TABLE IF NOT EXISTS ticket_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT,
        author_tag TEXT NOT NULL,
        author_id TEXT NOT NULL,
        is_bot BOOLEAN NOT NULL DEFAULT FALSE,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        links JSONB NOT NULL DEFAULT '[]'::jsonb
      );

      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS channel_id TEXT;
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS author_tag TEXT NOT NULL DEFAULT '';
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS author_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;

      CREATE TABLE IF NOT EXISTS ticket_message_edits (
        id BIGSERIAL PRIMARY KEY,
        message_id TEXT NOT NULL,
        edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        old_content TEXT NOT NULL DEFAULT '',
        new_content TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS ticket_staff_actions (
        id BIGSERIAL PRIMARY KEY,
        channel_id TEXT,
        ticket_channel_id TEXT,
        actor_id TEXT NOT NULL DEFAULT 'SYSTEM',
        actor_tag TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE ticket_staff_actions ADD COLUMN IF NOT EXISTS channel_id TEXT;
      ALTER TABLE ticket_staff_actions ADD COLUMN IF NOT EXISTS ticket_channel_id TEXT;
      ALTER TABLE ticket_staff_actions ALTER COLUMN ticket_channel_id DROP NOT NULL;
      ALTER TABLE ticket_staff_actions ADD COLUMN IF NOT EXISTS actor_id TEXT NOT NULL DEFAULT 'SYSTEM';
      ALTER TABLE ticket_staff_actions ADD COLUMN IF NOT EXISTS actor_tag TEXT NOT NULL DEFAULT '';
      ALTER TABLE ticket_staff_actions ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT '';
      ALTER TABLE ticket_staff_actions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      UPDATE ticket_staff_actions
      SET ticket_channel_id = COALESCE(ticket_channel_id, channel_id, '')
      WHERE ticket_channel_id IS NULL;

      UPDATE ticket_staff_actions
      SET channel_id = COALESCE(channel_id, ticket_channel_id, '')
      WHERE channel_id IS NULL;
    `);

    await clientDb.query(`CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);`).catch(e => console.warn('tickets_status_idx:', e.message));
    await clientDb.query(`CREATE INDEX IF NOT EXISTS ticket_messages_channel_idx ON ticket_messages(channel_id, created_at);`).catch(e => console.warn('ticket_messages_channel_idx:', e.message));

    console.log('PostgreSQL schema ready.');
  } catch (err) {
    console.error('initDatabase error:', err.message);
  } finally {
    clientDb.release();
  }
}

async function fetchRemoteState() {
  const response = await fetchWithTimeout(CONFIG_URL, { method: 'GET' }, 9000);
  if (!response.ok) throw new Error(`Config HTTP ${response.status}`);
  const data = await response.json();
  if (!data || data.ok === false) {
    throw new Error('Invalid response from Apps Script');
  }
  if (data.config) {
    data.config = normalizeConfig(data.config);
  }
  return data;
}

async function postToAppsScript(payload) {
  const response = await fetchWithTimeout(
    CONFIG_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    },
    10000
  );

  if (!response.ok) throw new Error(`Apps Script HTTP ${response.status}`);
  return response;
}

async function syncGuildMeta(guild) {
  if (!guild) return;

  await guild.channels.fetch();
  await guild.roles.fetch();

  const categories = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildCategory)
    .map(c => ({ id: c.id, name: c.name }));

  const channels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText)
    .map(c => ({ id: c.id, name: `#${c.name}` }));

  const roles = guild.roles.cache
    .filter(r => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: `@${r.name}` }));

  await postToAppsScript({
    type: 'sync_meta',
    meta: { categories, channels, roles }
  });

  console.log('Discord channels, categories and roles synced.');
}

function buildV2PanelBody(config) {
  const innerComponents = [];

  if (config.panelImageUrl && /^https?:\/\//i.test(config.panelImageUrl.trim())) {
    innerComponents.push({
      type: 12,
      items: [
        {
          media: { url: config.panelImageUrl.trim() }
        }
      ]
    });
  }

  const titleText = `## ${String(config.panelTitle || 'إنشاء تذكرة').slice(0, 200)}`;
  const descText = config.panelDescription ? `\n${String(config.panelDescription).slice(0, 1800)}` : '';
  innerComponents.push({
    type: 10,
    content: `${titleText}${descText}`.slice(0, 2000)
  });

  const types = Array.isArray(config.ticketTypes) ? config.ticketTypes.slice(0, 10) : [];

  for (let i = 0; i < types.length; i++) {
    const type = normalizeTicketType(types[i]);

    const sectionTitle = `### ${String(type.sectionTitle || `قسم #${i + 1}`).slice(0, 200)}`;
    const sectionDesc = String(type.sectionDescription || 'اضغط الزر أدناه لفتح الشكوى.').slice(0, 1500);

    innerComponents.push({
      type: 10,
      content: `${sectionTitle}\n\n${sectionDesc}`.slice(0, 2000)
    });

    innerComponents.push({
      type: 1,
      components: [
        {
          type: 2,
          style: mapButtonStyleNumber(type.buttonStyle),
          label: String(type.buttonLabel || type.sectionTitle || 'فتح شكوى').slice(0, 80),
          custom_id: `open_ticket_type:${type.id}`
        }
      ]
    });

    if (i < types.length - 1 || Boolean(config.panelNotes)) {
      innerComponents.push({
        type: 14,
        divider: true,
        spacing: 1
      });
    }
  }

  if (config.panelNotes) {
    innerComponents.push({
      type: 10,
      content: `**ملاحظات مهمة**\n\n${String(config.panelNotes).slice(0, 1500)}`.slice(0, 2000)
    });
  }

  return {
    flags: 32768,
    components: [
      {
        type: 17,
        components: innerComponents
      }
    ]
  };
}

function buildFallbackEmbedPanel(config) {
  const embed = new EmbedBuilder()
    .setColor(0xc9a65c)
    .setTitle(String(config.panelTitle || 'إنشاء تذكرة').slice(0, 256));

  if (config.panelDescription) {
    embed.setDescription(String(config.panelDescription).slice(0, 4096));
  }

  if (config.panelImageUrl && /^https?:\/\//i.test(config.panelImageUrl.trim())) {
    embed.setImage(config.panelImageUrl.trim());
  }

  const types = Array.isArray(config.ticketTypes) ? config.ticketTypes.slice(0, 25) : [];
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 0; i < types.length; i++) {
    const type = normalizeTicketType(types[i]);
    embed.addFields({
      name: String(type.sectionTitle || `نوع #${i + 1}`).slice(0, 256),
      value: `\n${String(type.sectionDescription || 'اضغط الزر أدناه لفتح الشكوى.').slice(0, 980)}\n──────────────`,
      inline: false
    });

    const button = new ButtonBuilder()
      .setCustomId(`open_ticket_type:${type.id}`)
      .setLabel(String(type.buttonLabel || type.sectionTitle || 'فتح شكوى').slice(0, 80))
      .setStyle(mapButtonStyle(type.buttonStyle));

    if (currentRow.components.length >= 5) {
      if (rows.length < 5) rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    if (rows.length < 5) currentRow.addComponents(button);
  }

  if (currentRow.components.length && rows.length < 5) {
    rows.push(currentRow);
  }

  if (config.panelNotes) {
    embed.addFields({
      name: 'ملاحظات مهمة',
      value: `\n${String(config.panelNotes).slice(0, 1024)}`.slice(0, 1024),
      inline: false
    });
  }

  return { embeds: [embed], components: rows };
}

async function sendV2Message(channelId, body) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  return rest.post(Routes.channelMessages(channelId), { body });
}

async function deliverPanelToChannel(channel, normCfg, forceNew = false) {
  const signature = JSON.stringify({
    ch: channel.id,
    img: normCfg.panelImageUrl,
    title: normCfg.panelTitle,
    desc: normCfg.panelDescription,
    notes: normCfg.panelNotes,
    types: normCfg.ticketTypes
  });

  if (!forceNew && signature === lastPanelSignature && lastPanelMessageIds.length > 0) {
    return { ok: true, channel };
  }

  if (lastPanelMessageIds.length > 0) {
    for (const oldId of lastPanelMessageIds) {
      const oldMsg = await channel.messages.fetch(oldId).catch(() => null);
      if (oldMsg) {
        await oldMsg.delete().catch(() => {});
      }
    }
    lastPanelMessageIds = [];
  }

  try {
    const v2Body = buildV2PanelBody(normCfg);
    const created = await sendV2Message(channel.id, v2Body);
    lastPanelMessageIds = [created.id];
    lastPanelSignature = signature;
    console.log(`V2 Panel sent in #${channel.name} (${channel.id}), msg=${created.id}, types=${normCfg.ticketTypes.length}`);
    return { ok: true, channel };
  } catch (v2Err) {
    console.warn('V2 panel fallback to embed:', v2Err.message);
    const fallbackPayload = buildFallbackEmbedPanel(normCfg);
    const sent = await channel.send(fallbackPayload);
    lastPanelMessageIds = [sent.id];
    lastPanelSignature = signature;
    return { ok: true, channel };
  }
}

async function ensurePanelChannel(config, forceNew = false, targetChannelIdOverride = '') {
  const normCfg = normalizeConfig(config || {});
  const targetChannelId = sanitizeSnowflake(targetChannelIdOverride) || normCfg.panelChannelId;

  if (!targetChannelId) {
    console.warn('Panel skipped: panelChannelId is empty in config.');
    return { ok: false, reason: 'لم يتم تحديد روم اللوحة في الإعدادات وحفظه.' };
  }

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.warn('Panel skipped: GUILD_ID not reachable.');
    return { ok: false, reason: 'تعذر الوصول إلى السيرفر.' };
  }

  const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.warn(`Panel skipped: channel ${targetChannelId} not found or not text channel.`);
    return { ok: false, reason: 'روم اللوحة غير موجود أو ليس روماً نصياً.' };
  }

  return deliverPanelToChannel(channel, normCfg, forceNew);
}

async function buildStatsEmbed(guildId) {
  const [summaryRes, typesRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_tickets,
         COUNT(*) FILTER (WHERE status = 'open')::int AS open_tickets,
         COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_tickets,
         COUNT(*) FILTER (WHERE claimed_by_id IS NOT NULL)::int AS claimed_tickets,
         COUNT(*) FILTER (WHERE escalated_to_owner = TRUE)::int AS escalated_tickets
       FROM tickets
       WHERE guild_id = $1`,
      [guildId]
    ),
    pool.query(
      `SELECT
         COALESCE(type_config->>'sectionTitle', 'غير محدد') AS type_name,
         COUNT(*)::int AS cnt
       FROM tickets
       WHERE guild_id = $1
       GROUP BY COALESCE(type_config->>'sectionTitle', 'غير محدد')
       ORDER BY cnt DESC
       LIMIT 10`,
      [guildId]
    )
  ]);

  const s = summaryRes.rows[0] || {
    total_tickets: 0,
    open_tickets: 0,
    closed_tickets: 0,
    claimed_tickets: 0,
    escalated_tickets: 0
  };

  const breakdownText = typesRes.rows.length
    ? typesRes.rows.map((r, i) => `**${i + 1}. ${r.type_name}:** ${r.cnt}`).join('\n')
    : 'لا توجد تذاكر مسجلة بعد.';

  return new EmbedBuilder()
    .setColor(0xc9a65c)
    .setTitle('📊 إحصائيات نظام الشكاوى | GAME HUB')
    .addFields(
      { name: 'إجمالي الشكاوى', value: String(s.total_tickets), inline: true },
      { name: 'الشكاوى المفتوحة', value: String(s.open_tickets), inline: true },
      { name: 'الشكاوى المغلقة', value: String(s.closed_tickets), inline: true },
      { name: 'الشكاوى المستلمة', value: String(s.claimed_tickets), inline: true },
      { name: 'المحولة إلى أونر', value: String(s.escalated_tickets), inline: true },
      { name: 'توزيع الأنواع', value: breakdownText.slice(0, 1024), inline: false }
    )
    .setTimestamp();
}

async function sendStatsToChannel(guild, config, channelOption) {
  const cfg = normalizeConfig(config || {});
  const targetChannel =
    (channelOption && channelOption.type === ChannelType.GuildText ? channelOption : null) ||
    (cfg.statsChannelId ? await guild.channels.fetch(cfg.statsChannelId).catch(() => null) : null);

  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    return {
      ok: false,
      reason: 'لم يتم تحديد شات الإحصائيات في لوحة التحكم أو لم يتم اختيار روم في الأمر.'
    };
  }

  const statsEmbed = await buildStatsEmbed(guild.id);
  await targetChannel.send({ embeds: [statsEmbed] });
  return { ok: true, channel: targetChannel };
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('send-panel')
      .setDescription('إرسال أو تحديث لوحة أنواع الشكاوى في الروم المحدد')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('send-ticket-panel')
      .setDescription('إرسال بانل الشكوى إلى روم الشكاوى المحدد')
      .addChannelOption(opt =>
        opt
          .setName('channel')
          .setDescription('روم اختياري لإرسال البانل إليه بدلاً من الروم الافتراضي')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('send-stats')
      .setDescription('إرسال إحصائيات الشكاوى في الشات المحدد')
      .addChannelOption(opt =>
        opt
          .setName('channel')
          .setDescription('شات اختياري لإرسال الإحصائيات إليه')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: commands }
  );
}

async function getTicket(channelId) {
  const result = await pool.query(
    'SELECT * FROM tickets WHERE channel_id=$1',
    [channelId]
  );

  return result.rows[0] || null;
}

async function addStaffAction(channelId, action, user) {
  await pool.query(
    `INSERT INTO ticket_staff_actions(channel_id,ticket_channel_id,actor_id,actor_tag,action)
     VALUES($1,$1,$2,$3,$4)`,
    [channelId, user?.id || 'SYSTEM', user?.tag || 'النظام', action]
  );
}

function isStaffMember(member, ticket) {
  if (!member || !ticket) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const staffRoles = ticket.type_config?.staffRoleIds || [];

  return Array.isArray(staffRoles) &&
    staffRoles.some(id => member.roles.cache.has(id));
}

function isOwnerEscalationEnabled(ticketType) {
  return Boolean(normalizeTicketType(ticketType).escalateToOwnerEnabled);
}

function resolveOwnerEscalationTarget(ticketType) {
  const normType = normalizeTicketType(ticketType);
  const cfg = normalizeConfig(cachedConfig || {});
  const ownerRoleId = normType.ownerRoleId || cfg.ownerEscalationRoleId;
  const ownerCategoryId = normType.ownerCategoryId || cfg.ownerEscalationCategoryId;
  return { ownerRoleId, ownerCategoryId };
}

function buildTicketActionRow(ticketType) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('claim_ticket')
      .setLabel('استلام الشكوى')
      .setStyle(ButtonStyle.Secondary)
  ];

  if (isOwnerEscalationEnabled(ticketType)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('escalate_to_owner')
        .setLabel('تحويل إلى أونر')
        .setStyle(ButtonStyle.Primary)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId('record_ticket')
      .setLabel('تسجيل التذكرة')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('غلق الشكوى')
      .setStyle(ButtonStyle.Danger)
  );

  return new ActionRowBuilder().addComponents(...buttons);
}

async function fetchTicketArchive(channelId) {
  const ticketResult = await pool.query(
    'SELECT * FROM tickets WHERE channel_id=$1',
    [channelId]
  );

  if (!ticketResult.rowCount) {
    throw new Error('Ticket not found in database');
  }

  const ticket = ticketResult.rows[0];

  const [messagesResult, editsResult, actionsResult] = await Promise.all([
    pool.query(
      'SELECT * FROM ticket_messages WHERE channel_id=$1 ORDER BY created_at ASC',
      [channelId]
    ),
    pool.query(
      `SELECT e.* FROM ticket_message_edits e
       JOIN ticket_messages m ON m.message_id=e.message_id
       WHERE m.channel_id=$1 ORDER BY e.edited_at ASC`,
      [channelId]
    ),
    pool.query(
      'SELECT * FROM ticket_staff_actions WHERE COALESCE(channel_id, ticket_channel_id)=$1 ORDER BY created_at ASC',
      [channelId]
    )
  ]);

  const editsByMessage = new Map();

  for (const edit of editsResult.rows) {
    if (!editsByMessage.has(edit.message_id)) {
      editsByMessage.set(edit.message_id, []);
    }

    editsByMessage.get(edit.message_id).push(edit);
  }

  const messages = messagesResult.rows.map(row => ({
    id: row.message_id,
    authorTag: row.author_tag,
    authorId: row.author_id,
    isBot: row.is_bot,
    content: row.content,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    attachments: row.attachments || [],
    links: row.links || [],
    editedHistory: editsByMessage.get(row.message_id) || []
  }));

  return {
    ticketNumber: ticket.ticket_number,
    channelId: ticket.channel_id,
    guildId: ticket.guild_id,
    openerId: ticket.opener_id,
    openerTag: ticket.opener_tag,
    typeConfig: ticket.type_config || {},
    answers: ticket.answers || {},
    openedAt: ticket.opened_at,
    closedAt: ticket.closed_at,
    closedBy: ticket.closed_by_tag
      ? `${ticket.closed_by_tag} (${ticket.closed_by_id})`
      : null,
    claimedBy: ticket.claimed_by_tag
      ? `${ticket.claimed_by_tag} (${ticket.claimed_by_id})`
      : null,
    escalatedToOwner: Boolean(ticket.escalated_to_owner),
    escalatedBy: ticket.escalated_by_tag
      ? `${ticket.escalated_by_tag} (${ticket.escalated_by_id})`
      : null,
    closeReason: ticket.close_reason,
    messages,
    staffActions: actionsResult.rows.map(a => ({
      time: a.created_at,
      actorTag: a.actor_tag,
      actorId: a.actor_id,
      action: a.action
    }))
  };
}

function generateArchiveHtml(data) {
  const answersHtml = Object.entries(data.answers || {})
    .map(([key, value]) =>
      `<div class="info-item"><b>${escapeHtml(key)}:</b> ${escapeHtml(value || '—')}</div>`
    ).join('');

  const actionsHtml = data.staffActions.length
    ? data.staffActions.map(action =>
      `<li><time>${escapeHtml(formatDateTime(action.time))}</time>
       <b>${escapeHtml(action.actorTag)}</b>
       (${escapeHtml(action.actorId)}): ${escapeHtml(action.action)}</li>`
    ).join('')
    : '<li>لا توجد إجراءات إدارية مسجلة.</li>';

  const messagesHtml = data.messages.map(message => {
    const edits = (message.editedHistory || []).map(edit =>
      `<div class="edit">
        <b>تعديل ${escapeHtml(formatDateTime(edit.edited_at))}</b>
        <p class="old">السابق: ${escapeHtml(edit.old_content)}</p>
        <p class="new">الجديد: ${escapeHtml(edit.new_content)}</p>
      </div>`
    ).join('');

    const attachments = (message.attachments || []).map(att => {
      const image = (att.contentType || '').startsWith('image/');

      return `<div class="attachment">
        <a href="${escapeHtml(att.url)}" target="_blank" rel="noopener">
          ${escapeHtml(att.name || 'مرفق')}
        </a>
        ${image ? `<p><img src="${escapeHtml(att.url)}" alt="attachment"></p>` : ''}
      </div>`;
    }).join('');

    const links = (message.links || []).map(url =>
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`
    ).join(' | ');

    return `<article class="message ${message.deletedAt ? 'deleted' : ''}">
      <header>
        <b>${escapeHtml(message.authorTag)}</b>
        <small>ID: ${escapeHtml(message.authorId)}</small>
        <time>${escapeHtml(formatDateTime(message.createdAt))}</time>
      </header>
      <div class="content">${escapeHtml(message.content || '(بدون نص)')}</div>
      ${message.deletedAt
        ? `<p class="deleted-label">حُذفت بتاريخ ${escapeHtml(formatDateTime(message.deletedAt))}</p>`
        : ''}
      ${edits}${attachments}${links ? `<div class="links">${links}</div>` : ''}
    </article>`;
  }).join('');

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ticket ${escapeHtml(data.ticketNumber)}</title>
  <style>
  *{box-sizing:border-box}
  body{font-family:Tahoma,Arial,sans-serif;background:#111318;color:#e5e7eb;margin:0;padding:24px;line-height:1.7}
  .wrap{max-width:980px;margin:auto;background:#1a1d24;border:1px solid #303644;border-radius:14px;padding:24px}
  h1{color:#f0d99b;border-bottom:1px solid #3a4050;padding-bottom:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;background:#242936;padding:14px;border-radius:9px}
  h2{font-size:18px;border-right:4px solid #c9a65c;padding-right:10px;margin-top:26px}
  .message{background:#242936;border:1px solid #343b4a;border-radius:9px;padding:14px;margin:12px 0;break-inside:avoid}
  .message.deleted{border-color:#da373c}
  .message header{display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #3b4252;padding-bottom:8px}
  time,small{color:#aeb6c5;font-size:12px}
  .message header time{margin-right:auto}
  .content{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:10px}
  a{color:#f0d99b;overflow-wrap:anywhere}
  .edit{background:#171b24;padding:8px 12px;margin-top:8px;border-right:3px solid #eab308}
  .old{color:#fca5a5}.new{color:#86efac}
  .attachment,.links{margin-top:8px;font-size:13px}
  .attachment img{max-width:320px;max-height:240px}
  .deleted-label{color:#fca5a5}
  .actions{background:#242936;padding:14px 32px;border-radius:9px}
  @media print{
    body{background:#fff;color:#111;padding:0}
    .wrap{background:#fff;color:#111;border:0}
    .grid,.message,.actions{background:#f4f4f4;color:#111;border-color:#ccc}
    a{color:#0645ad}
  }
  </style></head><body><main class="wrap">
  <h1>GAME HUB ARCHIVES — Ticket-${escapeHtml(data.ticketNumber)}</h1>
  <section class="grid">
  <div><b>رقم الشكوى:</b> ${escapeHtml(data.ticketNumber)}</div>
  <div><b>النوع:</b> ${escapeHtml(data.typeConfig.sectionTitle || 'غير محدد')}</div>
  <div><b>صاحب الشكوى:</b> ${escapeHtml(data.openerTag)} (${escapeHtml(data.openerId)})</div>
  <div><b>روم الشكوى:</b> ${escapeHtml(data.channelId)}</div>
  <div><b>الإداري المستلم:</b> ${escapeHtml(data.claimedBy || 'لم يُستلم')}</div>
  <div><b>تحويل إلى أونر:</b> ${data.escalatedToOwner ? `نعم (${escapeHtml(data.escalatedBy || '')})` : 'لا'}</div>
  <div><b>تاريخ الفتح:</b> ${escapeHtml(formatDateTime(data.openedAt))}</div>
  <div><b>تاريخ الإغلاق:</b> ${escapeHtml(formatDateTime(data.closedAt))}</div>
  <div><b>من أغلقها:</b> ${escapeHtml(data.closedBy || '—')}</div>
  <div><b>سبب الإغلاق:</b> ${escapeHtml(data.closeReason || '—')}</div>
  </section>
  <h2>إجابات النموذج</h2>
  <section class="grid">${answersHtml || 'لا توجد حقول'}</section>
  <h2>الإجراءات الإدارية</h2>
  <ul class="actions">${actionsHtml}</ul>
  <h2>سجل الرسائل والتعديلات والمرفقات</h2>
  ${messagesHtml || '<p>لا توجد رسائل مسجلة.</p>'}
  </main></body></html>`;
}

function generateArchiveText(data) {
  const lines = [
    `GAME HUB ARCHIVES — Ticket-${data.ticketNumber}`,
    `صاحب الشكوى: ${data.openerTag} (${data.openerId})`,
    `النوع: ${data.typeConfig.sectionTitle || 'غير محدد'}`,
    `روم الشكوى: ${data.channelId}`,
    `تاريخ الفتح: ${formatDateTime(data.openedAt)}`,
    `تاريخ الإغلاق: ${formatDateTime(data.closedAt)}`,
    `الإداري المستلم: ${data.claimedBy || 'لم يستلم'}`,
    `تحويل إلى أونر: ${data.escalatedToOwner ? `نعم (${data.escalatedBy || ''})` : 'لا'}`,
    `من أغلقها: ${data.closedBy || '—'}`,
    `سبب الإغلاق: ${data.closeReason || '—'}`,
    '',
    '=== إجابات النموذج ===',
    ...Object.entries(data.answers || {}).map(([k, v]) => `${k}: ${v}`),
    '',
    '=== الإجراءات الإدارية ===',
    ...data.staffActions.map(a =>
      `[${formatDateTime(a.time)}] ${a.actorTag} (${a.actorId}): ${a.action}`
    ),
    '',
    '=== الرسائل ===',
    ...data.messages.map(m => {
      const parts = [
        `[${formatDateTime(m.createdAt)}] ${m.authorTag} (${m.authorId})`,
        m.content || '(بدون نص)'
      ];

      for (const edit of m.editedHistory || []) {
        parts.push(
          `تعديل ${formatDateTime(edit.edited_at)} | السابق: ${edit.old_content} | الجديد: ${edit.new_content}`
        );
      }

      if (m.deletedAt) parts.push(`حُذفت: ${formatDateTime(m.deletedAt)}`);

      for (const a of m.attachments || []) {
        parts.push(`مرفق: ${a.name} — ${a.url}`);
      }

      for (const link of m.links || []) {
        parts.push(`رابط: ${link}`);
      }

      return parts.join('\n');
    })
  ];

  return lines.join('\n');
}

async function makePdf(html) {
  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function sendArchiveToLogChannel(guild, channelId, modeLabel) {
  const cfg = cachedConfig || {};

  if (!cfg.logChannelId) {
    throw new Error('لم يتم تحديد روم السجلات من لوحة التحكم.');
  }

  const logChannel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);

  if (!logChannel || logChannel.type !== ChannelType.GuildText) {
    throw new Error('روم السجلات المحدد غير موجود أو ليس روم نصياً.');
  }

  const data = await fetchTicketArchive(channelId);
  const html = generateArchiveHtml(data);
  const txt = generateArchiveText(data);

  const files = [
    new AttachmentBuilder(Buffer.from(html, 'utf8'), {
      name: `Ticket-${data.ticketNumber}.html`
    }),
    new AttachmentBuilder(Buffer.from(txt, 'utf8'), {
      name: `Ticket-${data.ticketNumber}.txt`
    })
  ];

  let pdfNote = 'PDF مرفق';

  try {
    const pdf = await makePdf(html);
    files.push(new AttachmentBuilder(pdf, {
      name: `Ticket-${data.ticketNumber}.pdf`
    }));
  } catch (error) {
    console.error('PDF generation failed:', error);
    pdfNote = 'تعذر إنشاء PDF؛ أُرسل HTML وTXT';
  }

  const embed = new EmbedBuilder()
    .setColor(modeLabel === 'إغلاق' ? 0xef4444 : 0xc9a65c)
    .setTitle(`GAME HUB ARCHIVES | Ticket-${data.ticketNumber} (${modeLabel})`)
    .addFields(
      {
        name: 'النوع',
        value: String(data.typeConfig.sectionTitle || 'غير محدد').slice(0, 1024),
        inline: true
      },
      {
        name: 'صاحب الشكوى',
        value: `<@${data.openerId}> (\`${data.openerId}\`)`,
        inline: true
      },
      {
        name: 'الإداري المستلم',
        value: String(data.claimedBy || 'لم يُستلم').slice(0, 1024),
        inline: true
      },
      { name: 'حالة الأرشيف', value: pdfNote, inline: false }
    )
    .setTimestamp();

  await logChannel.send({ embeds: [embed], files });

  return data.ticketNumber;
}

let readyHandled = false;
async function handleClientReady() {
  if (readyHandled) return;
  readyHandled = true;

  console.log(`Bot ready: ${client.user.tag}`);

  await initDatabase();
  botReady = true;

  await registerCommands().catch(err =>
    console.error('Command registration:', err)
  );

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);

  if (guild) {
    await syncGuildMeta(guild).catch(err =>
      console.error('Initial sync:', err)
    );
  }

  try {
    const state = await fetchRemoteState();

    if (state?.config) {
      cachedConfig = state.config;
      await ensurePanelChannel(cachedConfig);
    }
  } catch (err) {
    console.error('Initial config load:', err);
  }

  let isSyncRunning = false;
  setInterval(async () => {
    if (isSyncRunning) return;
    isSyncRunning = true;
    try {
      const currentGuild = await client.guilds.fetch(GUILD_ID).catch(() => null);

      if (currentGuild) {
        await syncGuildMeta(currentGuild);
      }

      const state = await fetchRemoteState();

      if (state?.config) {
        cachedConfig = state.config;
        await ensurePanelChannel(cachedConfig);
      }
    } catch (err) {
      console.error('Periodic sync:', err.message);
    } finally {
      isSyncRunning = false;
    }
  }, 60000);
}

client.once('clientReady', handleClientReady);
client.once('ready', handleClientReady);

client.on('guildMemberAdd', async member => {
  try {
    const state = await fetchRemoteState().catch(() => null);
    const cfg = state?.config || cachedConfig || {};

    if (!cfg.welcomeEnabled || !cfg.welcomeChannelId) return;

    const channel = await member.guild.channels
      .fetch(cfg.welcomeChannelId)
      .catch(() => null);

    if (channel?.type === ChannelType.GuildText) {
      await channel.send(formatText(cfg.welcomeMessage, member, member.guild));
    }
  } catch (err) {
    console.error('Welcome error:', err);
  }
});

client.on('guildMemberRemove', async member => {
  try {
    const state = await fetchRemoteState().catch(() => null);
    const cfg = state?.config || cachedConfig || {};

    if (!cfg.goodbyeEnabled || !cfg.goodbyeChannelId) return;

    const channel = await member.guild.channels
      .fetch(cfg.goodbyeChannelId)
      .catch(() => null);

    if (channel?.type === ChannelType.GuildText) {
      await channel.send(formatText(cfg.goodbyeMessage, member, member.guild));
    }
  } catch (err) {
    console.error('Goodbye error:', err);
  }
});

client.on('messageCreate', async message => {
  try {
    if (!message.guild || !message.channel ||
        (message.author?.bot && message.components?.length)) return;

    const exists = await pool.query(
      'SELECT 1 FROM tickets WHERE channel_id=$1',
      [message.channel.id]
    );

    if (!exists.rowCount) return;

    const m = serializeMessage(message);

    await pool.query(
      `INSERT INTO ticket_messages(
        message_id,channel_id,author_tag,author_id,is_bot,content,
        created_at,attachments,links
      )
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8::jsonb,$9::jsonb)
      ON CONFLICT(message_id) DO NOTHING`,
      [
        m.id, message.channel.id, m.authorTag, m.authorId, m.isBot,
        m.content, m.createdAt,
        JSON.stringify(m.attachments),
        JSON.stringify(m.links)
      ]
    );
  } catch (err) {
    console.error('messageCreate archive error:', err);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage.guild || !newMessage.channel) return;

    const exists = await pool.query(
      'SELECT 1 FROM tickets WHERE channel_id=$1',
      [newMessage.channel.id]
    );

    if (!exists.rowCount) return;

    if (oldMessage.partial) await oldMessage.fetch().catch(() => null);
    if (newMessage.partial) await newMessage.fetch().catch(() => null);

    const oldContent = oldMessage.content || '';
    const newContent = newMessage.content || '';

    if (oldContent === newContent) return;

    const msg = serializeMessage(newMessage);

    await pool.query(
      `INSERT INTO ticket_messages(
        message_id,channel_id,author_tag,author_id,is_bot,content,
        created_at,attachments,links
      )
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8::jsonb,$9::jsonb)
      ON CONFLICT(message_id) DO NOTHING`,
      [
        msg.id, newMessage.channel.id, msg.authorTag, msg.authorId,
        msg.isBot, oldContent, msg.createdAt,
        JSON.stringify(msg.attachments), JSON.stringify(msg.links)
      ]
    );

    const stored = await pool.query(
      'SELECT content FROM ticket_messages WHERE message_id=$1',
      [msg.id]
    );

    const previous = stored.rows[0]?.content ?? oldContent;

    await pool.query(
      `INSERT INTO ticket_message_edits(message_id,old_content,new_content)
       VALUES($1,$2,$3)`,
      [msg.id, previous, newContent]
    );

    await pool.query(
      `UPDATE ticket_messages
       SET content=$2,attachments=$3::jsonb,links=$4::jsonb
       WHERE message_id=$1`,
      [
        msg.id,
        newContent,
        JSON.stringify(msg.attachments),
        JSON.stringify([...new Set([...msg.links, ...extractUrls(newContent)])])
      ]
    );
  } catch (err) {
    console.error('messageUpdate archive error:', err);
  }
});

client.on('messageDelete', async message => {
  try {
    if (!message.guild || !message.channel) return;

    const exists = await pool.query(
      'SELECT 1 FROM tickets WHERE channel_id=$1',
      [message.channel.id]
    );

    if (!exists.rowCount) return;

    if (message.partial) {
      await message.fetch().catch(() => null);
    }

    const msg = serializeMessage(message);

    await pool.query(
      `INSERT INTO ticket_messages(
        message_id,channel_id,author_tag,author_id,is_bot,content,
        created_at,deleted_at,attachments,links
      )
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),NOW(),$8::jsonb,$9::jsonb)
      ON CONFLICT(message_id) DO UPDATE SET deleted_at=NOW()`,
      [
        msg.id, message.channel.id, msg.authorTag, msg.authorId,
        msg.isBot, msg.content, msg.createdAt,
        JSON.stringify(msg.attachments), JSON.stringify(msg.links)
      ]
    );
  } catch (err) {
    console.error('messageDelete archive error:', err);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    const state = await fetchRemoteState().catch(() => null);

    if (state?.config) cachedConfig = state.config;

    const cfg = cachedConfig || {};

    if (interaction.isChatInputCommand()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply(ephemeralReply({
          content: 'هذا الأمر مخصص للأدمن فقط.'
        }));
      }

      if (interaction.commandName === 'send-panel') {
        const panelRes = await ensurePanelChannel(cfg, true);
        if (!panelRes?.ok) {
          return interaction.reply(ephemeralReply({
            content: `تعذر إرسال اللوحة: ${panelRes?.reason || 'تحقق من إعدادات روم اللوحة وحفظها من لوحة التحكم.'}`
          }));
        }

        return interaction.reply(ephemeralReply({
          content: `تم إرسال لوحة الشكاوى بنجاح في ${panelRes.channel}.`
        }));
      }

      if (interaction.commandName === 'send-ticket-panel') {
        const chosenChannel = interaction.options.getChannel('channel');
        const panelRes = await ensurePanelChannel(cfg, true, chosenChannel?.id || '');
        if (!panelRes?.ok) {
          return interaction.reply(ephemeralReply({
            content: `تعذر إرسال بانل الشكوى: ${panelRes?.reason || 'تحقق من إعدادات روم الشكاوى في لوحة التحكم.'}`
          }));
        }

        return interaction.reply(ephemeralReply({
          content: `تم إرسال بانل الشكوى إلى ${panelRes.channel}.`
        }));
      }

      if (interaction.commandName === 'send-stats') {
        const chosenChannel = interaction.options.getChannel('channel');
        const statsRes = await sendStatsToChannel(interaction.guild, cfg, chosenChannel);
        if (!statsRes?.ok) {
          return interaction.reply(ephemeralReply({
            content: `تعذر إرسال الإحصائيات: ${statsRes?.reason || 'تحقق من إعدادات شات الإحصائيات.'}`
          }));
        }

        return interaction.reply(ephemeralReply({
          content: `تم إرسال الإحصائيات بنجاح في ${statsRes.channel}.`
        }));
      }
    }

    if (interaction.isButton()) {
      const [action, param] = interaction.customId.split(':');

      if (action === 'open_ticket_type') {
        const rawType = (cfg.ticketTypes || []).find(t => t.id === param);
        const type = rawType ? normalizeTicketType(rawType) : null;

        if (!type) {
          return interaction.reply(ephemeralReply({
            content: 'هذا النوع غير متوفر حالياً.'
          }));
        }

        const allowedRoles = Array.isArray(type.allowedRoleIds)
          ? type.allowedRoleIds
          : [];

        if (
          allowedRoles.length &&
          !interaction.member.roles.cache.some(r => allowedRoles.includes(r.id))
        ) {
          return interaction.reply(ephemeralReply({
            content: 'عذراً، هذا النوع من الشكاوى غير متاح لرولك.'
          }));
        }

        const modal = new ModalBuilder()
          .setCustomId(`submit_ticket:${type.id}`)
          .setTitle((type.sectionTitle || 'تقديم شكوى').slice(0, 45));

        (type.fields || []).slice(0, 5).forEach((field, index) => {
          const input = new TextInputBuilder()
            .setCustomId(`field_${index}`)
            .setLabel((field.label || `حقل ${index + 1}`).slice(0, 45))
            .setPlaceholder((field.placeholder || '').slice(0, 100))
            .setStyle(
              field.style === 'Paragraph'
                ? TextInputStyle.Paragraph
                : TextInputStyle.Short
            )
            .setRequired(field.required !== false);

          modal.addComponents(
            new ActionRowBuilder().addComponents(input)
          );
        });

        return interaction.showModal(modal);
      }

      if (action === 'escalate_to_owner') {
        const lockRes = await runWithLock(`escalate:${interaction.channel.id}`, async () => {
          const ticket = await getTicket(interaction.channel.id);

          if (!ticket || ticket.status !== 'open') {
            return interaction.reply(ephemeralReply({
              content: 'هذه الشكوى غير موجودة أو مغلقة.'
            }));
          }

          const type = normalizeTicketType(ticket.type_config);
          if (!isOwnerEscalationEnabled(type)) {
            return interaction.reply(ephemeralReply({
              content: 'زر التحويل إلى أونر غير مفعّل لهذا النوع من الشكاوى.'
            }));
          }

          if (!isStaffMember(interaction.member, ticket)) {
            return interaction.reply(ephemeralReply({
              content: 'هذا الإجراء متاح للرولات الإدارية فقط.'
            }));
          }

          if (ticket.escalated_to_owner) {
            return interaction.reply(ephemeralReply({
              content: 'تم تحويل هذه الشكوى إلى أونر مسبقاً.'
            }));
          }

          const { ownerRoleId, ownerCategoryId } = resolveOwnerEscalationTarget(type);
          if (!ownerRoleId || !ownerCategoryId) {
            return interaction.reply(ephemeralReply({
              content: 'لم يتم تحديد رول الأونر أو كاتكوري التحويل من لوحة التحكم.'
            }));
          }

          const targetCategory = await interaction.guild.channels
            .fetch(ownerCategoryId)
            .catch(() => null);

          if (!targetCategory || targetCategory.type !== ChannelType.GuildCategory) {
            return interaction.reply(ephemeralReply({
              content: 'الكاتكوري المحدد للتحويل غير موجود أو غير صالح.'
            }));
          }

          await interaction.channel.permissionOverwrites.edit(ownerRoleId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true
          });

          await interaction.channel.setParent(targetCategory.id, { lockPermissions: false });

          await pool.query(
            `UPDATE tickets
             SET escalated_to_owner=TRUE, escalated_at=NOW(), escalated_by_id=$2, escalated_by_tag=$3
             WHERE channel_id=$1`,
            [interaction.channel.id, interaction.user.id, interaction.user.tag]
          );

          await addStaffAction(
            interaction.channel.id,
            `حوّل الشكوى إلى أونر (الرول: ${ownerRoleId}، الكاتكوري: ${ownerCategoryId})`,
            interaction.user
          );

          await interaction.channel.send({
            content: `<@&${ownerRoleId}>`,
            embeds: [
              new EmbedBuilder()
                .setColor(0xc9a65c)
                .setTitle('👑 تم تحويل الشكوى إلى أونر')
                .setDescription(
                  `**بواسطة:** <@${interaction.user.id}>\n` +
                  `**رول الأونر:** <@&${ownerRoleId}>\n` +
                  `**الكاتكوري الجديد:** <#${ownerCategoryId}>`
                )
                .setTimestamp()
            ],
            allowedMentions: { roles: [ownerRoleId] }
          });

          return interaction.reply(ephemeralReply({
            content: `تم تحويل الشكوى إلى <@&${ownerRoleId}> ونقلها إلى <#${ownerCategoryId}>.`
          }));
        });

        if (lockRes.locked) {
          return interaction.reply(ephemeralReply({
            content: 'جاري تنفيذ عملية التحويل حالياً...'
          }));
        }
        return;
      }

      if (['claim_ticket', 'record_ticket', 'close_ticket'].includes(action)) {
        const ticket = await getTicket(interaction.channel.id);

        if (!ticket || ticket.status !== 'open') {
          return interaction.reply(ephemeralReply({
            content: 'هذه الشكوى غير موجودة أو مغلقة.'
          }));
        }

        if (!isStaffMember(interaction.member, ticket)) {
          return interaction.reply(ephemeralReply({
            content: 'هذا الإجراء متاح للرولات الإدارية فقط.'
          }));
        }

        if (action === 'claim_ticket') {
          const lockRes = await runWithLock(`claim:${interaction.channel.id}`, async () => {
            const claimed = await pool.query(
              `UPDATE tickets
               SET claimed_by_id=$2,claimed_by_tag=$3
               WHERE channel_id=$1 AND status='open' AND claimed_by_id IS NULL
               RETURNING channel_id`,
              [interaction.channel.id, interaction.user.id, interaction.user.tag]
            );

            if (!claimed.rowCount) {
              return interaction.reply(ephemeralReply({
                content: 'الشكوى مستلمة مسبقاً أو لم تعد مفتوحة.'
              }));
            }

            await addStaffAction(
              interaction.channel.id,
              'استلم الشكوى',
              interaction.user
            );

            return interaction.reply({
              content: `تم استلام الشكوى بواسطة <@${interaction.user.id}>.`
            });
          });

          if (lockRes.locked) {
            return interaction.reply(ephemeralReply({
              content: 'جاري معالجة الاستلام...'
            }));
          }
          return;
        }

        if (action === 'record_ticket') {
          const lockRes = await runWithLock(`record:${interaction.channel.id}`, async () => {
            await addStaffAction(
              interaction.channel.id,
              'قام بتسجيل وأرشفة التذكرة',
              interaction.user
            );

            const number = await sendArchiveToLogChannel(
              interaction.guild,
              interaction.channel.id,
              'تسجيل'
            );

            return interaction.reply(ephemeralReply({
              content: `تم إرسال أرشيف Ticket-${number} إلى روم السجلات.`
            }));
          });

          if (lockRes.locked) {
            return interaction.reply(ephemeralReply({
              content: 'جاري أرشفة التذكرة حالياً...'
            }));
          }
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`close_reason_modal:${interaction.channel.id}`)
          .setTitle('إغلاق وأرشفة الشكوى');

        const reason = new TextInputBuilder()
          .setCustomId('close_reason_input')
          .setLabel('سبب إغلاق الشكوى')
          .setPlaceholder('اكتب سبب إغلاق الشكوى...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(reason)
        );

        return interaction.showModal(modal);
      }
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith('close_reason_modal:')
    ) {
      const channelId = interaction.customId.split(':')[1];

      if (interaction.channelId !== channelId) {
        return interaction.reply(ephemeralReply({
          content: 'طلب غير صالح.'
        }));
      }

      const ticket = await getTicket(channelId);

      if (
        !ticket ||
        ticket.status !== 'open' ||
        !isStaffMember(interaction.member, ticket)
      ) {
        return interaction.reply(ephemeralReply({
          content: 'لا تملك صلاحية إغلاق هذه الشكوى.'
        }));
      }

      const reason = interaction.fields.getTextInputValue('close_reason_input');

      await pool.query(
        `UPDATE tickets
         SET closed_at=NOW(),closed_by_id=$2,closed_by_tag=$3,close_reason=$4
         WHERE channel_id=$1`,
        [channelId, interaction.user.id, interaction.user.tag, reason]
      );

      await addStaffAction(
        channelId,
        `أغلق الشكوى — السبب: ${reason}`,
        interaction.user
      );

      await interaction.reply({
        content: 'تم حفظ الإغلاق وتجهيز الأرشيف. سيتم حذف الروم بعد نجاح إرسال السجل.'
      });

      try {
        await sendArchiveToLogChannel(
          interaction.guild,
          channelId,
          'إغلاق'
        );

        await pool.query(
          "UPDATE tickets SET status='closed' WHERE channel_id=$1",
          [channelId]
        );

        setTimeout(
          () => interaction.channel.delete().catch(console.error),
          3000
        );
      } catch (archiveError) {
        console.error('Archive send failed; ticket channel kept:', archiveError);

        await interaction.followUp(ephemeralReply({
          content: `تعذر إرسال الأرشيف: ${archiveError.message}. تم الاحتفاظ بالروم والبيانات؛ أعد المحاولة بعد إصلاح روم السجلات.`
        })).catch(() => {});
      }

      return;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith('submit_ticket:')
    ) {
      const typeId = interaction.customId.split(':')[1];
      const rawType = (cfg.ticketTypes || []).find(t => t.id === typeId);
      const type = rawType ? normalizeTicketType(rawType) : null;

      if (!type) {
        return interaction.reply(ephemeralReply({
          content: 'تعذر العثور على إعدادات نوع الشكوى.'
        }));
      }

      const allowedRoles = Array.isArray(type.allowedRoleIds)
        ? type.allowedRoleIds
        : [];

      if (
        allowedRoles.length &&
        !interaction.member.roles.cache.some(r => allowedRoles.includes(r.id))
      ) {
        return interaction.reply(ephemeralReply({
          content: 'عذراً، هذا النوع من الشكاوى غير متاح لرولك.'
        }));
      }

      const answers = {};

      (type.fields || []).slice(0, 5).forEach((field, index) => {
        answers[field.label || `حقل ${index + 1}`] =
          interaction.fields.getTextInputValue(`field_${index}`);
      });

      if (!cfg.allowMultipleTicketsPerUser) {
        const existingOpen = await pool.query(
          "SELECT channel_id FROM tickets WHERE guild_id=$1 AND opener_id=$2 AND status='open' LIMIT 1",
          [interaction.guild.id, interaction.user.id]
        );

        if (existingOpen.rowCount > 0) {
          const prevChannelId = sanitizeSnowflake(existingOpen.rows[0].channel_id);
          const prevChannel = prevChannelId
            ? await interaction.guild.channels.fetch(prevChannelId).catch(() => null)
            : null;

          if (prevChannel && prevChannel.type === ChannelType.GuildText) {
            return interaction.reply(ephemeralReply({
              content: `لديك شكوى مفتوحة بالفعل في <#${prevChannel.id}>.`
            }));
          }

          if (prevChannelId) {
            await pool.query(
              "UPDATE tickets SET status='closed', closed_at=COALESCE(closed_at, NOW()), close_reason=COALESCE(close_reason, 'تم إغلاقها تلقائياً لعدم وجود الروم') WHERE channel_id=$1",
              [prevChannelId]
            );
          }
        }
      }

      const ticketNumber = await generateNextTicketNumber(pool);

      const overwrites = [
        {
          id: interaction.guild.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles
          ]
        }
      ];

      (type.staffRoleIds || []).forEach(roleId => {
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles
          ]
        });
      });

      const channel = await interaction.guild.channels.create({
        name: `ticket-${ticketNumber}`,
        type: ChannelType.GuildText,
        parent: type.categoryId || null,
        permissionOverwrites: overwrites
      });

      try {
        await pool.query(
          `INSERT INTO tickets(
            channel_id,guild_id,ticket_number,user_id,user_tag,opener_id,opener_tag,type_config,answers
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
          [
            channel.id,
            interaction.guild.id,
            ticketNumber,
            interaction.user.id,
            interaction.user.tag,
            interaction.user.id,
            interaction.user.tag,
            JSON.stringify(type),
            JSON.stringify(answers)
          ]
        );

        await pool.query(
          `INSERT INTO ticket_staff_actions(channel_id,ticket_channel_id,actor_id,actor_tag,action)
           VALUES($1,$1,$2,$3,$4)`,
          [
            channel.id,
            interaction.user.id,
            interaction.user.tag,
            `فتح الشكوى (النوع: ${type.sectionTitle || 'غير محدد'})`
          ]
        );
      } catch (dbError) {
        await channel.delete().catch(() => {});
        throw dbError;
      }

      const detailLines = Object.entries(answers)
        .map(([label, value]) => `**${label}:** ${value || '—'}`)
        .join('\n');

      const description = [
        `**رقم التذكرة:** Ticket-${ticketNumber}`,
        `**النوع:** ${type.sectionTitle || 'شكوى'}`,
        `**الأولوية:** ${type.defaultPriority || 'عادية'}`,
        `**تم الإنشاء بواسطة:** <@${interaction.user.id}>`,
        detailLines ? `\n${detailLines}` : '',
        type.evidenceNote || ''
      ].filter(Boolean).join('\n');

      const embed = new EmbedBuilder()
        .setColor(0xc9a65c)
        .setTitle(`شكوى #${ticketNumber}`)
        .setDescription(description)
        .setTimestamp();

      const buttons = buildTicketActionRow(type);

      const mentions = (type.staffRoleIds || [])
        .map(id => `<@&${id}>`)
        .join(' ');

      await channel.send({
        content: mentions
          ? `${mentions} | <@${interaction.user.id}>`
          : `<@${interaction.user.id}>`,
        embeds: [embed],
        components: [buttons]
      });

      return interaction.reply(ephemeralReply({
        content: `تم فتح شكواك بنجاح: ${channel}`
      }));
    }
  } catch (error) {
    console.error('Interaction error:', error);

    const message =
      `حدث خطأ أثناء تنفيذ العملية: ${String(error.message || error).slice(0, 700)}`;

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(ephemeralReply({
        content: message
      })).catch(() => {});
    } else {
      await interaction.reply(ephemeralReply({
        content: message
      })).catch(() => {});
    }
  }
});

process.on('unhandledRejection', error =>
  console.error('Unhandled rejection:', error)
);

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received; closing connections.`);
  botReady = false;
  await pool.end().catch(() => {});
  await client.destroy().catch(() => {});
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

client.login(TOKEN);
