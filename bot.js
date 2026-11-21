const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

// ================================
// ENVIRONMENT & PORT VALIDATION
// ================================

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CONFIG_URL = process.env.CONFIG_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT) || 8080;

if (!TOKEN) throw new Error('DISCORD_TOKEN is missing');
if (!GUILD_ID) throw new Error('GUILD_ID is missing');
if (!CONFIG_URL) throw new Error('CONFIG_URL is missing');
if (!DATABASE_URL) throw new Error('DATABASE_URL is missing');

// ================================
// HTTP SERVER FOR RAILWAY
// ================================

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OS Shop Bot is running');
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// ================================
// DATABASE
// ================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id BIGSERIAL PRIMARY KEY,
        ticket_number BIGINT UNIQUE NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        user_tag TEXT NOT NULL,
        type_id TEXT,
        type_name TEXT,
        answers JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'open',
        claimed_by TEXT,
        claimed_by_tag TEXT,
        escalated_to_owner BOOLEAN NOT NULL DEFAULT FALSE,
        escalated_at TIMESTAMPTZ,
        escalated_by TEXT,
        escalated_by_tag TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        closed_by TEXT,
        closed_by_tag TEXT,
        close_reason TEXT,
        reopened_count INTEGER NOT NULL DEFAULT 0,
        last_reopened_at TIMESTAMPTZ,
        last_reopened_by TEXT,
        last_reopened_by_tag TEXT,
        reopen_reason TEXT,
        rating INTEGER,
        rating_comment TEXT,
        rated_at TIMESTAMPTZ,
        archive_count INTEGER NOT NULL DEFAULT 0,
        is_recording BOOLEAN NOT NULL DEFAULT FALSE
      );

      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_reopened_by TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_reopened_by_tag TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_reason TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rating INTEGER;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rating_comment TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_recording BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_to_owner BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_by TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_by_tag TEXT;

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id BIGSERIAL PRIMARY KEY,
        ticket_channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        author_id TEXT,
        author_tag TEXT,
        content TEXT,
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ,
        edited_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(ticket_channel_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS ticket_message_edits (
        id BIGSERIAL PRIMARY KEY,
        ticket_channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        editor_id TEXT,
        old_content TEXT,
        new_content TEXT,
        edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ticket_staff_actions (
        id BIGSERIAL PRIMARY KEY,
        ticket_channel_id TEXT NOT NULL,
        staff_id TEXT,
        staff_tag TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ticket_views (
        id BIGSERIAL PRIMARY KEY,
        ticket_channel_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        viewer_tag TEXT NOT NULL,
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stats_panel_state (
        id INTEGER PRIMARY KEY,
        channel_id TEXT,
        message_id TEXT,
        updated_at TIMESTAMPTZ
      );

      INSERT INTO stats_panel_state (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS ticket_counter (
        id INTEGER PRIMARY KEY,
        last_number BIGINT NOT NULL DEFAULT 0
      );

      INSERT INTO ticket_counter (id, last_number)
      VALUES (1, 123)
      ON CONFLICT (id) DO NOTHING;

      CREATE INDEX IF NOT EXISTS idx_tickets_status
      ON tickets(status);

      CREATE INDEX IF NOT EXISTS idx_ticket_messages_channel
      ON ticket_messages(ticket_channel_id);

      CREATE INDEX IF NOT EXISTS idx_ticket_actions_channel
      ON ticket_staff_actions(ticket_channel_id);

      CREATE INDEX IF NOT EXISTS idx_ticket_edits_channel
      ON ticket_message_edits(ticket_channel_id);

      CREATE INDEX IF NOT EXISTS idx_ticket_views_channel
      ON ticket_views(ticket_channel_id);
    `);

    await client.query('COMMIT');
    console.log('PostgreSQL database initialized');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ================================
// DISCORD CLIENT & STATE
// ================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

let cachedConfig = null;
let lastPanelSignature = '';
let lastPanelMessageIds = [];

// channel_id -> ticket data
const activeTickets = new Map();

// temporary rating selection per user -> { channelId, rating }
const pendingRatings = new Map();

// lock set to prevent duplicate/concurrent actions
const actionLocks = new Set();

function sanitizeSnowflake(val) {
  return typeof val === 'string' && /^\d{15,25}$/.test(val.trim()) ? val.trim() : '';
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
    categoryId: sanitizeSnowflake(t.categoryId),
    allowedRoleIds: sanitizeSnowflakeArray(t.allowedRoleIds),
    staffRoleIds: sanitizeSnowflakeArray(t.staffRoleIds),
    reopenRoleIds: sanitizeSnowflakeArray(t.reopenRoleIds),
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
    reopenRoleIds: sanitizeSnowflakeArray(cfg.reopenRoleIds),
    ticketTypes: Array.isArray(cfg.ticketTypes) ? cfg.ticketTypes.map(normalizeTicketType) : []
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runWithLock(lockKey, taskFn) {
  if (actionLocks.has(lockKey)) {
    return { locked: true };
  }
  actionLocks.add(lockKey);
  try {
    const data = await taskFn();
    return { locked: false, data };
  } finally {
    actionLocks.delete(lockKey);
  }
}

// ================================
// HELPERS
// ================================

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  if (!value) return 'غير متوفر';

  return new Date(value).toLocaleString('ar-IQ', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'غير متوفر';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}ي`);
  if (hours > 0) parts.push(`${hours}س`);
  if (minutes > 0) parts.push(`${minutes}د`);
  if (parts.length === 0) parts.push(`${seconds}ث`);
  return parts.join(' ');
}

function getTicketDurations(ticket) {
  const created = ticket?.created_at ? new Date(ticket.created_at).getTime() : null;
  const claimed = ticket?.claimed_at ? new Date(ticket.claimed_at).getTime() : null;
  const closed = ticket?.closed_at ? new Date(ticket.closed_at).getTime() : null;

  const claimDurationMs = (created && claimed) ? Math.max(0, claimed - created) : null;
  const totalProcessMs = (created && closed) ? Math.max(0, closed - created) : null;
  const claimToCloseMs = (claimed && closed) ? Math.max(0, closed - claimed) : null;

  return {
    claimDuration: claimDurationMs !== null ? formatDurationMs(claimDurationMs) : 'لم يُستلم بعد',
    totalProcess: totalProcessMs !== null ? formatDurationMs(totalProcessMs) : 'لم تُغلق بعد',
    claimToClose: claimToCloseMs !== null ? formatDurationMs(claimToCloseMs) : 'غير متوفر',
    claimDurationMs,
    totalProcessMs,
    claimToCloseMs
  };
}

function formatTicketDescription(ticket) {
  const answers = Array.isArray(ticket?.answers) ? ticket.answers : [];
  if (!answers.length) return 'غير متوفر';

  return answers
    .map(a => `**${a.label || 'سؤال'}:** ${a.value || 'بدون إجابة'}`)
    .join('\n');
}

function truncateText(text, maxLength = 950) {
  const str = String(text || '');
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

function mapButtonStyle(style) {
  const styles = {
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger,
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary
  };

  return styles[style] || ButtonStyle.Primary;
}

function formatText(text, member, guild) {
  return String(text || '')
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{tag}', member.user.tag)
    .replaceAll('{server}', guild.name)
    .replaceAll('{count}', String(guild.memberCount));
}

function getTicketType(typeId) {
  const types = cachedConfig?.ticketTypes || [];
  return types.find(t => t.id === typeId) || null;
}

function isOwnerEscalationEnabledForType(ticketType) {
  return Boolean(ticketType?.escalateToOwnerEnabled);
}

function resolveOwnerEscalationTarget(ticketType) {
  const ownerRoleId =
    sanitizeSnowflake(ticketType?.ownerRoleId) ||
    sanitizeSnowflake(cachedConfig?.ownerEscalationRoleId);

  const ownerCategoryId =
    sanitizeSnowflake(ticketType?.ownerCategoryId) ||
    sanitizeSnowflake(cachedConfig?.ownerEscalationCategoryId);

  return { ownerRoleId, ownerCategoryId };
}

function isTicketChannel(channelId) {
  return activeTickets.has(channelId);
}

async function fetchRemoteState() {
  try {
    const response = await fetchWithTimeout(CONFIG_URL, { method: 'GET' }, 8000);

    if (!response.ok) {
      throw new Error(`Config request failed: ${response.status}`);
    }

    const data = await response.json();

    if (!data || !data.ok) {
      throw new Error('Apps Script returned an invalid response');
    }

    cachedConfig = normalizeConfig(data.config || {});
    return { ...data, config: cachedConfig };
  } catch (error) {
    console.error('Config fetch error:', error);
    return null;
  }
}

async function postToAppsScript(payload) {
  try {
    const response = await fetchWithTimeout(
      CONFIG_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Apps Script POST failed: ${response.status}`);
    }
  } catch (error) {
    console.error('Apps Script POST error:', error);
  }
}

async function buildStatisticsSummary() {
  const countsRes = await pool.query(`
    SELECT
      COUNT(*)::int AS total_tickets,
      COUNT(*) FILTER (WHERE status = 'open')::int AS open_tickets,
      COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_tickets
    FROM tickets
  `);

  const allTicketsRes = await pool.query(`
    SELECT
      user_id, user_tag, status,
      claimed_by, claimed_by_tag,
      closed_by, closed_by_tag,
      created_at, claimed_at, closed_at,
      rating, rating_comment
    FROM tickets
  `);

  const rows = allTicketsRes.rows;

  let totalClaimMs = 0;
  let claimSamples = 0;

  let totalProcessMs = 0;
  let processSamples = 0;

  let totalClaimToCloseMs = 0;
  let claimToCloseSamples = 0;

  const staffMap = new Map();

  function ensureStaff(id, tag) {
    if (!id) return null;
    if (!staffMap.has(id)) {
      staffMap.set(id, {
        id,
        tag: tag || id,
        claimedCount: 0,
        closedCount: 0,
        ratings: []
      });
    }
    const entry = staffMap.get(id);
    if (tag) entry.tag = tag;
    return entry;
  }

  for (const r of rows) {
    const d = getTicketDurations(r);
    if (d.claimDurationMs !== null) {
      totalClaimMs += d.claimDurationMs;
      claimSamples++;
    }
    if (d.totalProcessMs !== null) {
      totalProcessMs += d.totalProcessMs;
      processSamples++;
    }
    if (d.claimToCloseMs !== null) {
      totalClaimToCloseMs += d.claimToCloseMs;
      claimToCloseSamples++;
    }

    if (r.claimed_by) {
      const s = ensureStaff(r.claimed_by, r.claimed_by_tag);
      if (s) {
        s.claimedCount++;
        if (typeof r.rating === 'number' && r.rating >= 1 && r.rating <= 5) {
          s.ratings.push(r.rating);
        }
      }
    }

    if (r.closed_by) {
      const s = ensureStaff(r.closed_by, r.closed_by_tag);
      if (s) {
        s.closedCount++;
        if (!r.claimed_by && typeof r.rating === 'number' && r.rating >= 1 && r.rating <= 5) {
          s.ratings.push(r.rating);
        }
      }
    }
  }

  const staffList = [...staffMap.values()]
    .sort((a, b) => (b.closedCount + b.claimedCount) - (a.closedCount + a.claimedCount))
    .map(s => {
      const avgRating = s.ratings.length
        ? (s.ratings.reduce((acc, v) => acc + v, 0) / s.ratings.length).toFixed(1)
        : null;
      return {
        ...s,
        avgRating,
        ratingsCount: s.ratings.length
      };
    });

  return {
    totalTickets: countsRes.rows[0]?.total_tickets ?? 0,
    openTickets: countsRes.rows[0]?.open_tickets ?? 0,
    closedTickets: countsRes.rows[0]?.closed_tickets ?? 0,
    avgClaimDuration: claimSamples > 0 ? formatDurationMs(totalClaimMs / claimSamples) : 'غير متوفر',
    avgTotalDuration: processSamples > 0 ? formatDurationMs(totalProcessMs / processSamples) : 'غير متوفر',
    avgClaimToCloseDuration: claimToCloseSamples > 0 ? formatDurationMs(totalClaimToCloseMs / claimToCloseSamples) : 'غير متوفر',
    staffList,
    updatedAt: new Date().toISOString()
  };
}

async function syncGuildMeta(guild) {
  try {
    await guild.channels.fetch();
    await guild.roles.fetch();

    const categories = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildCategory)
      .map(c => ({
        id: c.id,
        name: c.name
      }));

    const channels = guild.channels.cache
      .filter(c =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement
      )
      .map(c => ({
        id: c.id,
        name: `#${c.name}`
      }));

    const roles = guild.roles.cache
      .filter(r => !r.managed && r.id !== guild.id)
      .map(r => ({
        id: r.id,
        name: r.name
      }));

    const statsSummary = await buildStatisticsSummary();

    await postToAppsScript({
      type: 'sync_meta',
      meta: {
        categories,
        channels,
        roles,
        statsSummary
      }
    });

    console.log('Guild metadata and stats summary synchronized');
  } catch (error) {
    console.error('Guild sync error:', error);
  }
}

// ================================
// DATABASE HELPERS
// ================================

async function nextTicketNumber() {
  const result = await pool.query(`
    UPDATE ticket_counter
    SET last_number = last_number + 1
    WHERE id = 1
    RETURNING last_number
  `);

  return Number(result.rows[0].last_number);
}

async function getTicket(channelId) {
  const result = await pool.query(
    'SELECT * FROM tickets WHERE channel_id = $1 LIMIT 1',
    [channelId]
  );

  return result.rows[0] || null;
}

async function addStaffAction(channelId, staff, action, details = '') {
  await pool.query(`
    INSERT INTO ticket_staff_actions
      (ticket_channel_id, staff_id, staff_tag, action, details)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    channelId,
    staff?.id || null,
    staff?.tag || null,
    action,
    details
  ]);
}

async function recordTicketView(channelId, viewer) {
  if (!viewer) return;
  await pool.query(`
    INSERT INTO ticket_views
      (ticket_channel_id, viewer_id, viewer_tag)
    VALUES ($1, $2, $3)
  `, [
    channelId,
    viewer.id,
    viewer.tag
  ]);
}

async function saveMessage(message) {
  if (!message.guild || !isTicketChannel(message.channelId)) return;

  const attachments = [...message.attachments.values()].map(a => ({
    name: a.name,
    url: a.url,
    contentType: a.contentType,
    size: a.size
  }));

  await pool.query(`
    INSERT INTO ticket_messages (
      ticket_channel_id,
      message_id,
      author_id,
      author_tag,
      content,
      attachments,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    ON CONFLICT (ticket_channel_id, message_id)
    DO UPDATE SET
      content = EXCLUDED.content,
      attachments = EXCLUDED.attachments
  `, [
    message.channelId,
    message.id,
    message.author?.id || null,
    message.author?.tag || null,
    message.content || '',
    JSON.stringify(attachments),
    message.createdAt
  ]);
}

// ================================
// DAILY 24H STATISTICS PANEL
// ================================

function buildStatisticsEmbed(stats) {
  const staffLines = stats.staffList.length
    ? stats.staffList.slice(0, 15).map(s => {
        const ratingPart = s.avgRating ? ` | ⭐ ${s.avgRating}/5 (${s.ratingsCount})` : '';
        return `• <@${s.id}> (**${escapeTextForDiscord(s.tag)}**): مستلمة **${s.claimedCount}** | مغلقة **${s.closedCount}**${ratingPart}`;
      }).join('\n')
    : 'لا توجد إحصائيات إداريين مسجلة بعد.';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📊 لوحة إحصائيات الشكاوى والتذاكر')
    .setDescription('تحديث تلقائي كل **24 ساعة** دون إرسال رسائل مكررة.')
    .addFields(
      {
        name: '📌 إجمالي الشكاوى',
        value: `**${stats.totalTickets}**`,
        inline: true
      },
      {
        name: '🟢 المفتوحة',
        value: `**${stats.openTickets}**`,
        inline: true
      },
      {
        name: '🔴 المغلقة',
        value: `**${stats.closedTickets}**`,
        inline: true
      },
      {
        name: '⏱️ متوسط وقت الاستلام',
        value: `**${stats.avgClaimDuration}**`,
        inline: true
      },
      {
        name: '⏳ متوسط مدة المعالجة الكلية',
        value: `**${stats.avgTotalDuration}**`,
        inline: true
      },
      {
        name: '🛠️ متوسط المعالجة بعد الاستلام',
        value: `**${stats.avgClaimToCloseDuration}**`,
        inline: true
      },
      {
        name: '👮 إحصائيات الإداريين (الاستلام والإغلاق والتقييم)',
        value: truncateText(staffLines, 1024),
        inline: false
      }
    )
    .setFooter({ text: `آخر تحديث: ${formatDate(stats.updatedAt)}` })
    .setTimestamp(new Date(stats.updatedAt));
}

function escapeTextForDiscord(str = '') {
  return String(str).replace(/[`*_~|]/g, '');
}

async function updateOrSendStatsPanel(guild) {
  const statsChannelId =
    cachedConfig?.statsChannelId ||
    cachedConfig?.statisticsChannelId ||
    null;

  if (!statsChannelId) return;

  const channel = await guild.channels.fetch(statsChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const stats = await buildStatisticsSummary();
  const embed = buildStatisticsEmbed(stats);

  const stateRes = await pool.query(
    'SELECT channel_id, message_id FROM stats_panel_state WHERE id = 1'
  );
  const state = stateRes.rows[0] || {};

  if (state.channel_id === channel.id && state.message_id) {
    const existingMsg = await channel.messages.fetch(state.message_id).catch(() => null);
    if (existingMsg) {
      await existingMsg.edit({
        embeds: [embed],
        allowedMentions: { parse: [] }
      }).catch(() => null);

      await pool.query(`
        UPDATE stats_panel_state
        SET updated_at = NOW()
        WHERE id = 1
      `);
      return;
    }
  }

  const sent = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] }
  });

  await pool.query(`
    UPDATE stats_panel_state
    SET channel_id = $1,
        message_id = $2,
        updated_at = NOW()
    WHERE id = 1
  `, [channel.id, sent.id]);
}

// ================================
// ARCHIVE GENERATOR
// ================================

async function getArchiveData(channelId) {
  const ticketResult = await pool.query(
    'SELECT * FROM tickets WHERE channel_id = $1',
    [channelId]
  );

  if (!ticketResult.rows.length) return null;

  const messagesResult = await pool.query(`
    SELECT *
    FROM ticket_messages
    WHERE ticket_channel_id = $1
    ORDER BY created_at ASC, id ASC
  `, [channelId]);

  const editsResult = await pool.query(`
    SELECT *
    FROM ticket_message_edits
    WHERE ticket_channel_id = $1
    ORDER BY edited_at ASC
  `, [channelId]);

  const actionsResult = await pool.query(`
    SELECT *
    FROM ticket_staff_actions
    WHERE ticket_channel_id = $1
    ORDER BY created_at ASC
  `, [channelId]);

  const viewsResult = await pool.query(`
    SELECT *
    FROM ticket_views
    WHERE ticket_channel_id = $1
    ORDER BY viewed_at ASC
  `, [channelId]);

  return {
    ticket: ticketResult.rows[0],
    messages: messagesResult.rows,
    edits: editsResult.rows,
    actions: actionsResult.rows,
    views: viewsResult.rows
  };
}

function generateArchiveHtml(data) {
  const t = data.ticket;
  const d = getTicketDurations(t);

  const answers = Array.isArray(t.answers) ? t.answers : [];

  const answerHtml = answers.map(a => `
    <div class="item">
      <strong>${escapeHtml(a.label)}</strong>
      <p>${escapeHtml(a.value)}</p>
    </div>
  `).join('');

  const messagesHtml = data.messages.map(m => {
    const attachments = Array.isArray(m.attachments)
      ? m.attachments
      : [];

    const attachmentHtml = attachments.map(a => `
      <div class="attachment">
        📎 <a href="${escapeHtml(a.url)}">${escapeHtml(a.name || 'مرفق')}</a>
      </div>
    `).join('');

    return `
      <div class="message ${m.is_deleted ? 'deleted' : ''}">
        <div class="message-head">
          <strong>${escapeHtml(m.author_tag || 'مستخدم غير معروف')}</strong>
          <small>${escapeHtml(formatDate(m.created_at))}</small>
        </div>
        <p>${escapeHtml(m.content || '')}</p>
        ${m.is_deleted ? '<b>تم حذف هذه الرسالة</b>' : ''}
        ${attachmentHtml}
      </div>
    `;
  }).join('');

  const editsHtml = data.edits.map(e => `
    <div class="item">
      <strong>تعديل رسالة: ${escapeHtml(e.message_id)}</strong>
      <p>قبل التعديل: ${escapeHtml(e.old_content || '')}</p>
      <p>بعد التعديل: ${escapeHtml(e.new_content || '')}</p>
      <small>${escapeHtml(formatDate(e.edited_at))}</small>
    </div>
  `).join('');

  const viewsHtml = data.views.map(v => `
    <div class="item">
      <strong>اطلع / شاهد الشكوى: ${escapeHtml(v.viewer_tag || v.viewer_id)}</strong>
      <small>${escapeHtml(formatDate(v.viewed_at))}</small>
    </div>
  `).join('');

  const actionsHtml = data.actions.map(a => `
    <div class="item">
      <strong>${escapeHtml(a.action)}</strong>
      <p>${escapeHtml(a.staff_tag || a.staff_id || 'غير معروف')}</p>
      <p>${escapeHtml(a.details || '')}</p>
      <small>${escapeHtml(formatDate(a.created_at))}</small>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>أرشيف الشكوى #${t.ticket_number}</title>
<style>
body {
  font-family: Arial, Tahoma, sans-serif;
  background: #f3f4f6;
  color: #222;
  padding: 25px;
  line-height: 1.8;
}
.container {
  max-width: 950px;
  margin: auto;
  background: white;
  padding: 25px;
  border-radius: 12px;
}
h1, h2 {
  border-bottom: 2px solid #5865f2;
  padding-bottom: 8px;
}
.item, .message {
  background: #f7f7f9;
  border: 1px solid #ddd;
  padding: 12px;
  border-radius: 8px;
  margin: 10px 0;
  overflow-wrap: anywhere;
}
.message-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.message p {
  white-space: pre-wrap;
}
.deleted {
  border-color: #da373c;
}
.attachment {
  margin-top: 8px;
}
small {
  color: #666;
}
</style>
</head>
<body>
<div class="container">
<h1>أرشيف الشكوى رقم ${t.ticket_number}</h1>

<h2>معلومات الشكوى والمدد والتقييم</h2>
<div class="item">
<p>صاحب الشكوى: ${escapeHtml(t.user_tag)}</p>
<p>رقم المستخدم: ${escapeHtml(t.user_id)}</p>
<p>نوع الشكوى: ${escapeHtml(t.type_name || '')}</p>
<p>الحالة: ${escapeHtml(t.status)}</p>
<p>تم التحويل إلى أونر: ${t.escalated_to_owner ? `نعم (${escapeHtml(t.escalated_by_tag || t.escalated_by || '')})` : 'لا'}</p>
<p>تاريخ الفتح: ${escapeHtml(formatDate(t.created_at))}</p>
<p>وقت الاستلام: ${escapeHtml(formatDate(t.claimed_at))}</p>
<p>تاريخ الإغلاق: ${escapeHtml(formatDate(t.closed_at))}</p>
<p>مدة الاستلام من الفتح: ${escapeHtml(d.claimDuration)}</p>
<p>مدة المعالجة الكلية (فتح إلى إغلاق): ${escapeHtml(d.totalProcess)}</p>
<p>مدة المعالجة بعد الاستلام: ${escapeHtml(d.claimToClose)}</p>
<p>عدد مرات إعادة الفتح: ${escapeHtml(String(t.reopened_count || 0))}</p>
<p>آخر سبب لإعادة الفتح: ${escapeHtml(t.reopen_reason || 'غير متوفر')}</p>
<p>المستلم: ${escapeHtml(t.claimed_by_tag || 'لم يتم الاستلام')}</p>
<p>المغلق بواسطة: ${escapeHtml(t.closed_by_tag || 'لم تغلق')}</p>
<p>سبب الإغلاق: ${escapeHtml(t.close_reason || 'غير محدد')}</p>
<p>تقييم الإدارة: ${t.rating ? `${escapeHtml(String(t.rating))} / 5` : 'لم يتم التقييم بعد'}</p>
<p>ملاحظة التقييم: ${escapeHtml(t.rating_comment || 'لا توجد ملاحظة')}</p>
</div>

<h2>إجابات صاحب الشكوى</h2>
${answerHtml || '<p>لا توجد إجابات</p>'}

<h2>سجل المشاهدات والاطلاع</h2>
${viewsHtml || '<p>لا توجد مشاهدات مسجلة</p>'}

<h2>سجل المحادثة</h2>
${messagesHtml || '<p>لا توجد رسائل مسجلة</p>'}

<h2>تعديلات الرسائل</h2>
${editsHtml || '<p>لا توجد تعديلات مسجلة</p>'}

<h2>الإجراءات الإدارية</h2>
${actionsHtml || '<p>لا توجد إجراءات مسجلة</p>'}

</div>
</body>
</html>`;
}

function generateArchiveTxt(data) {
  const t = data.ticket;
  const d = getTicketDurations(t);
  const lines = [];

  lines.push(`أرشيف الشكوى رقم ${t.ticket_number}`);
  lines.push('================================');
  lines.push(`صاحب الشكوى: ${t.user_tag}`);
  lines.push(`رقم المستخدم: ${t.user_id}`);
  lines.push(`نوع الشكوى: ${t.type_name || ''}`);
  lines.push(`الحالة: ${t.status}`);
  lines.push(`تم التحويل إلى أونر: ${t.escalated_to_owner ? `نعم (${t.escalated_by_tag || t.escalated_by || ''})` : 'لا'}`);
  lines.push(`تاريخ الفتح: ${formatDate(t.created_at)}`);
  lines.push(`وقت الاستلام: ${formatDate(t.claimed_at)}`);
  lines.push(`تاريخ الإغلاق: ${formatDate(t.closed_at)}`);
  lines.push(`مدة الاستلام من الفتح: ${d.claimDuration}`);
  lines.push(`مدة المعالجة الكلية: ${d.totalProcess}`);
  lines.push(`مدة المعالجة بعد الاستلام: ${d.claimToClose}`);
  lines.push(`عدد مرات إعادة الفتح: ${t.reopened_count || 0}`);
  lines.push(`آخر سبب لإعادة الفتح: ${t.reopen_reason || 'غير متوفر'}`);
  lines.push(`المستلم: ${t.claimed_by_tag || 'لم يتم الاستلام'}`);
  lines.push(`المغلق بواسطة: ${t.closed_by_tag || 'لم تغلق'}`);
  lines.push(`سبب الإغلاق: ${t.close_reason || 'غير محدد'}`);
  lines.push(`تقييم الإدارة: ${t.rating ? `${t.rating} / 5` : 'لم يتم التقييم بعد'}`);
  lines.push(`ملاحظة التقييم: ${t.rating_comment || 'لا توجد ملاحظة'}`);

  lines.push('\nالإجابات');
  lines.push('================================');

  for (const a of (Array.isArray(t.answers) ? t.answers : [])) {
    lines.push(`${a.label}: ${a.value}`);
  }

  lines.push('\nسجل المشاهدات');
  lines.push('================================');

  for (const v of data.views) {
    lines.push(`${v.viewer_tag || v.viewer_id} - ${formatDate(v.viewed_at)}`);
  }

  lines.push('\nالمحادثة');
  lines.push('================================');

  for (const m of data.messages) {
    lines.push('');
    lines.push(`[${formatDate(m.created_at)}] ${m.author_tag || 'غير معروف'}`);
    lines.push(m.content || '');

    if (m.is_deleted) {
      lines.push('[تم حذف الرسالة]');
    }

    const attachments = Array.isArray(m.attachments)
      ? m.attachments
      : [];

    for (const a of attachments) {
      lines.push(`مرفق: ${a.name || 'ملف'} - ${a.url}`);
    }
  }

  lines.push('\nتعديلات الرسائل');
  lines.push('================================');

  for (const e of data.edits) {
    lines.push(`الرسالة: ${e.message_id}`);
    lines.push(`قبل: ${e.old_content || ''}`);
    lines.push(`بعد: ${e.new_content || ''}`);
    lines.push(`التاريخ: ${formatDate(e.edited_at)}`);
  }

  lines.push('\nالإجراءات الإدارية');
  lines.push('================================');

  for (const a of data.actions) {
    lines.push(`${a.action} - ${a.staff_tag || a.staff_id || ''}`);
    lines.push(a.details || '');
    lines.push(formatDate(a.created_at));
  }

  return lines.join('\n');
}

async function sendArchiveToLogChannel(guild, channelId, label) {
  const data = await getArchiveData(channelId);

  if (!data) {
    console.error('Ticket archive data not found:', channelId);
    return false;
  }

  if (!cachedConfig?.logChannelId) {
    await fetchRemoteState();
  }

  const logChannelId = cachedConfig?.logChannelId;

  if (!logChannelId) {
    console.error('No log channel selected in dashboard');
    return false;
  }

  const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);

  if (!logChannel || !logChannel.isTextBased()) {
    console.error('Log channel not found or not text-based');
    return false;
  }

  const t = data.ticket;
  const d = getTicketDurations(t);
  const number = t.ticket_number;

  const html = generateArchiveHtml(data);
  const txt = generateArchiveTxt(data);

  const files = [
    new AttachmentBuilder(
      Buffer.from(html, 'utf8'),
      { name: `ticket-${number}.html` }
    ),
    new AttachmentBuilder(
      Buffer.from(txt, 'utf8'),
      { name: `ticket-${number}.txt` }
    )
  ];

  const viewsSummary = data.views.length
    ? data.views.slice(-8).map(v => `• <@${v.viewer_id}> — ${formatDate(v.viewed_at)}`).join('\n')
    : 'لا توجد مشاهدات مسجلة';

  const embed = new EmbedBuilder()
    .setColor(t.status === 'closed' ? 0xDA373C : 0x5865F2)
    .setTitle(`سجل الشكوى #${number}`)
    .addFields(
      {
        name: 'صاحب الشكوى',
        value: t.user_id ? `<@${t.user_id}> (${t.user_tag || ''})` : (t.user_tag || 'غير متوفر'),
        inline: true
      },
      {
        name: 'نوع الشكوى',
        value: t.type_name || 'غير محدد',
        inline: true
      },
      {
        name: 'تاريخ الشكوى',
        value: formatDate(t.created_at),
        inline: true
      },
      {
        name: 'مستلم الشكوى',
        value: t.claimed_by ? `<@${t.claimed_by}>` : 'لم يتم الاستلام',
        inline: true
      },
      {
        name: 'وقت الاستلام',
        value: formatDate(t.claimed_at),
        inline: true
      },
      {
        name: 'تحويل إلى أونر',
        value: t.escalated_to_owner ? `نعم (${t.escalated_by ? `<@${t.escalated_by}>` : t.escalated_by_tag || ''})` : 'لا',
        inline: true
      },
      {
        name: 'اللي غلق الشكوى',
        value: t.closed_by ? `<@${t.closed_by}>` : 'لم تُغلق بعد',
        inline: true
      },
      {
        name: 'وقت الإغلاق',
        value: formatDate(t.closed_at),
        inline: true
      },
      {
        name: 'مدة المعالجة (فتح → إغلاق)',
        value: d.totalProcess,
        inline: true
      },
      {
        name: 'مدة المعالجة (استلام → إغلاق)',
        value: d.claimToClose,
        inline: true
      },
      {
        name: 'تقييم الإدارة',
        value: t.rating ? `⭐ **${t.rating}/5**${t.rating_comment ? `\n${truncateText(t.rating_comment, 200)}` : ''}` : 'لم يُقيّم بعد',
        inline: true
      },
      {
        name: 'نوع السجل',
        value: label || 'سجل التذكرة',
        inline: true
      },
      {
        name: 'إعادة الفتح',
        value: `عدد المرات: **${t.reopened_count || 0}**${t.reopen_reason ? `\nالسبب: ${truncateText(t.reopen_reason, 200)}` : ''}`,
        inline: true
      },
      {
        name: 'سجل المشاهدات والاطلاع',
        value: truncateText(viewsSummary, 1024),
        inline: false
      },
      {
        name: 'وصف الشكوى',
        value: truncateText(formatTicketDescription(t), 1024),
        inline: false
      }
    )
    .setTimestamp();

  try {
    await logChannel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });

    await logChannel.send({
      content: `📄 **ملف السجل للشكوى #${number}:**`,
      files,
      allowedMentions: { parse: [] }
    });

    await pool.query(
      'UPDATE tickets SET archive_count = archive_count + 1 WHERE channel_id = $1',
      [channelId]
    );

    return true;
  } catch (error) {
    console.error('Archive send error:', error);
    return false;
  }
}

// ================================
// PANEL (SINGLE UNIFIED CARD WITH SECTION + DESCRIPTION + BUTTON PER TYPE)
// ================================

function buildPanelMessages() {
  const cfg = cachedConfig || {};
  const types = cfg.ticketTypes || [];

  const container = new ContainerBuilder();

  if (cfg.panelImageUrl && /^https?:\/\//i.test(cfg.panelImageUrl.trim())) {
    const gallery = new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(cfg.panelImageUrl.trim())
    );
    container.addMediaGalleryComponents(gallery);
  }

  const headerParts = [];
  if (cfg.panelTitle) {
    headerParts.push(`## ${cfg.panelTitle.trim()}`);
  } else {
    headerParts.push('## إنشاء تذكرة');
  }

  if (cfg.panelDescription && cfg.panelDescription.trim()) {
    headerParts.push(cfg.panelDescription.trim());
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(headerParts.join('\n'))
  );

  for (let i = 0; i < types.length; i++) {
    const type = types[i];

    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small)
    );

    const sectionLines = [];
    if (type.sectionTitle) {
      sectionLines.push(`### ${type.sectionTitle.trim()}`);
    }
    if (type.sectionDescription) {
      sectionLines.push(type.sectionDescription.trim());
    }

    if (sectionLines.length) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(sectionLines.join('\n'))
      );
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`open_ticket_type:${type.id}`)
        .setLabel((type.buttonLabel || type.sectionTitle || 'فتح شكوى').slice(0, 80))
        .setStyle(mapButtonStyle(type.buttonStyle))
    );

    container.addActionRowComponents(row);
  }

  const extraNotes = cfg.panelNotes || cfg.panelRules || cfg.rulesText || '';
  if (extraNotes && String(extraNotes).trim()) {
    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`\`\`\`\n${String(extraNotes).trim()}\n\`\`\``)
    );
  }

  return [
    {
      components: [container],
      flags: MessageFlags.IsComponentsV2
    }
  ];
}

async function deleteTrackedPanelMessages(channel) {
  for (const msgId of lastPanelMessageIds) {
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (msg) {
      await msg.delete().catch(() => null);
    }
  }
  lastPanelMessageIds = [];
}

async function sendPanelMessagesToChannel(channel) {
  await deleteTrackedPanelMessages(channel);
  const payloads = buildPanelMessages();
  const sentIds = [];

  for (const payload of payloads) {
    const sent = await channel.send(payload);
    sentIds.push(sent.id);
  }

  lastPanelMessageIds = sentIds;
  lastPanelSignature = JSON.stringify(payloads);
  return sentIds;
}

async function ensurePanelChannel(guild) {
  const channelId = cachedConfig?.panelChannelId;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const payloads = buildPanelMessages();
  const signature = JSON.stringify(payloads);

  if (signature === lastPanelSignature && lastPanelMessageIds.length > 0) {
    return;
  }

  if (lastPanelMessageIds.length === payloads.length) {
    let allEdited = true;
    for (let i = 0; i < payloads.length; i++) {
      const msg = await channel.messages.fetch(lastPanelMessageIds[i]).catch(() => null);
      if (!msg) {
        allEdited = false;
        break;
      }
      await msg.edit(payloads[i]).catch(() => {
        allEdited = false;
      });
    }
    if (allEdited) {
      lastPanelSignature = signature;
      return;
    }
  }

  await sendPanelMessagesToChannel(channel);
}

// ================================
// STAFF & REOPEN PERMISSIONS
// ================================

function isStaffMember(member, ticketType) {
  if (!member) return false;

  if (!ticketType) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  const staffRoles = ticketType.staffRoleIds || [];

  if (!staffRoles.length) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  return staffRoles.some(roleId => member.roles.cache.has(roleId)) ||
    member.permissions.has(PermissionFlagsBits.Administrator);
}

function canReopenTicket(member, ticketType) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const reopenRoles =
    cachedConfig?.reopenRoleIds ||
    ticketType?.reopenRoleIds ||
    ticketType?.staffRoleIds ||
    [];

  if (!reopenRoles.length) return false;
  return reopenRoles.some(roleId => member.roles.cache.has(roleId));
}

async function setStaffSendPermission(channel, ticketType, canSend) {
  if (!channel || !ticketType) return;

  for (const roleId of (ticketType.staffRoleIds || [])) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: canSend,
      ReadMessageHistory: true,
      AttachFiles: canSend,
      EmbedLinks: canSend
    }).catch(error => {
      console.error('Could not update staff role permission:', error);
    });
  }
}

function buildTicketControlRows(ticketType) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('claim_ticket')
      .setLabel('استلام الشكوى')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('view_ticket_log')
      .setLabel('تسجيل مشاهدة')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('reopen_ticket')
      .setLabel('إعادة فتح الشكوى')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2Buttons = [
    new ButtonBuilder()
      .setCustomId('record_ticket')
      .setLabel('تسجيل التذكرة')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('إغلاق الشكوى')
      .setStyle(ButtonStyle.Danger)
  ];

  if (isOwnerEscalationEnabledForType(ticketType)) {
    row2Buttons.splice(
      1,
      0,
      new ButtonBuilder()
        .setCustomId('escalate_to_owner')
        .setLabel('تحويل إلى أونر')
        .setStyle(ButtonStyle.Primary)
    );
  }

  const row2 = new ActionRowBuilder().addComponents(...row2Buttons);

  return [row1, row2];
}

function buildRatingRow(channelId) {
  return new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map(score =>
      new ButtonBuilder()
        .setCustomId(`rate_ticket:${channelId}:${score}`)
        .setLabel(`${score} ⭐`)
        .setStyle(score >= 4 ? ButtonStyle.Success : (score === 3 ? ButtonStyle.Secondary : ButtonStyle.Danger))
    )
  );
}

// ================================
// SLASH COMMAND
// ================================

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('send-panel')
      .setDescription('إرسال لوحة الشكاوى')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('update-stats')
      .setDescription('تحديث لوحة الإحصائيات الآن')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: commands }
  );

  console.log('Slash commands registered');
}

// ================================
// STARTUP
// ================================

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await initDatabase();

    const guild = await client.guilds.fetch(GUILD_ID);

    await registerCommands();
    await syncGuildMeta(guild);
    await fetchRemoteState();
    await ensurePanelChannel(guild);
    await updateOrSendStatsPanel(guild);

    const result = await pool.query(`
      SELECT *
      FROM tickets
      WHERE status = 'open'
    `);

    for (const ticket of result.rows) {
      activeTickets.set(ticket.channel_id, ticket);
    }

    console.log(`Restored ${result.rows.length} open tickets`);

    let isSyncRunning = false;
    setInterval(async () => {
      if (isSyncRunning) return;
      isSyncRunning = true;
      try {
        await fetchRemoteState();
        await ensurePanelChannel(guild);
        await syncGuildMeta(guild);
      } catch (err) {
        console.error('Periodic sync error:', err);
      } finally {
        isSyncRunning = false;
      }
    }, 60000);

    let isStatsSyncRunning = false;
    setInterval(async () => {
      if (isStatsSyncRunning) return;
      isStatsSyncRunning = true;
      try {
        await fetchRemoteState();
        await updateOrSendStatsPanel(guild);
        await syncGuildMeta(guild);
      } catch (err) {
        console.error('Daily stats sync error:', err);
      } finally {
        isStatsSyncRunning = false;
      }
    }, 24 * 60 * 60 * 1000);

  } catch (error) {
    console.error('Startup error:', error);
  }
});

// ================================
// WELCOME / GOODBYE
// ================================

client.on('guildMemberAdd', async member => {
  try {
    if (!cachedConfig) await fetchRemoteState();

    const cfg = cachedConfig;
    if (!cfg?.welcomeEnabled || !cfg.welcomeChannelId) return;

    const channel = await member.guild.channels
      .fetch(cfg.welcomeChannelId)
      .catch(() => null);

    if (!channel) return;

    await channel.send({
      content: formatText(
        cfg.welcomeMessage,
        member,
        member.guild
      ),
      allowedMentions: {
        users: [member.id]
      }
    });
  } catch (error) {
    console.error('Welcome error:', error);
  }
});

client.on('guildMemberRemove', async member => {
  try {
    if (!cachedConfig) await fetchRemoteState();

    const cfg = cachedConfig;
    if (!cfg?.goodbyeEnabled || !cfg.goodbyeChannelId) return;

    const channel = await member.guild.channels
      .fetch(cfg.goodbyeChannelId)
      .catch(() => null);

    if (!channel) return;

    await channel.send({
      content: String(cfg.goodbyeMessage || '')
        .replaceAll('{tag}', member.user.tag)
        .replaceAll('{server}', member.guild.name)
        .replaceAll('{count}', String(member.guild.memberCount)),
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error('Goodbye error:', error);
  }
});

// ================================
// MESSAGE LOGGING
// ================================

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    await saveMessage(message);
  } catch (error) {
    console.error('Message save error:', error);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      newMessage = await newMessage.fetch().catch(() => null);
    }

    if (!newMessage || !isTicketChannel(newMessage.channelId)) return;

    const oldContent = oldMessage.content || '';
    const newContent = newMessage.content || '';

    await pool.query(`
      INSERT INTO ticket_message_edits (
        ticket_channel_id,
        message_id,
        editor_id,
        old_content,
        new_content
      )
      VALUES ($1, $2, $3, $4, $5)
    `, [
      newMessage.channelId,
      newMessage.id,
      newMessage.author?.id || null,
      oldContent,
      newContent
    ]);

    await saveMessage(newMessage);

  } catch (error) {
    console.error('Message update error:', error);
  }
});

client.on('messageDelete', async message => {
  try {
    if (!isTicketChannel(message.channelId)) return;

    await pool.query(`
      UPDATE ticket_messages
      SET is_deleted = TRUE,
          deleted_at = NOW()
      WHERE ticket_channel_id = $1
        AND message_id = $2
    `, [
      message.channelId,
      message.id
    ]);

  } catch (error) {
    console.error('Message delete error:', error);
  }
});

client.on('messageDeleteBulk', async messages => {
  try {
    for (const message of messages.values()) {
      if (!isTicketChannel(message.channelId)) continue;

      await pool.query(`
        UPDATE ticket_messages
        SET is_deleted = TRUE,
            deleted_at = NOW()
        WHERE ticket_channel_id = $1
          AND message_id = $2
      `, [
        message.channelId,
        message.id
      ]);
    }
  } catch (error) {
    console.error('Bulk delete error:', error);
  }
});

// ================================
// INTERACTIONS
// ================================

client.on('interactionCreate', async interaction => {
  try {

    // ----------------------------
    // SLASH COMMANDS
    // ----------------------------

    if (interaction.isChatInputCommand()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: 'هذا الأمر مخصص للإدارة العليا فقط.',
          ephemeral: true
        });
      }

      if (interaction.commandName === 'send-panel') {
        await fetchRemoteState();

        const guild = interaction.guild;
        const channelId = cachedConfig?.panelChannelId;

        if (!channelId) {
          return interaction.reply({
            content: 'حدد روم لوحة الشكاوى من لوحة التحكم أولاً.',
            ephemeral: true
          });
        }

        const channel = await guild.channels.fetch(channelId).catch(() => null);

        if (!channel || !channel.isTextBased()) {
          return interaction.reply({
            content: 'روم اللوحة غير موجود أو غير صالح.',
            ephemeral: true
          });
        }

        await sendPanelMessagesToChannel(channel);

        return interaction.reply({
          content: 'تم إرسال لوحة الشكاوى.',
          ephemeral: true
        });
      }

      if (interaction.commandName === 'update-stats') {
        await interaction.deferReply({ ephemeral: true });
        await fetchRemoteState();
        await updateOrSendStatsPanel(interaction.guild);
        return interaction.editReply('تم تحديث لوحة الإحصائيات بنجاح.');
      }
    }

    // ----------------------------
    // BUTTONS
    // ----------------------------

    if (interaction.isButton()) {

      // Open ticket form
      if (interaction.customId.startsWith('open_ticket_type:')) {
        const typeId = interaction.customId.split(':')[1];
        const type = getTicketType(typeId);

        if (!type) {
          return interaction.reply({
            content: 'نوع الشكوى غير موجود. حدّث لوحة الشكاوى.',
            ephemeral: true
          });
        }

        const member = interaction.member;
        const allowedRoles = type.allowedRoleIds || [];

        if (
          allowedRoles.length &&
          !allowedRoles.some(id => member.roles.cache.has(id))
        ) {
          return interaction.reply({
            content: 'لا تملك صلاحية فتح هذا النوع من الشكاوى.',
            ephemeral: true
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`submit_ticket:${type.id}`)
          .setTitle((type.sectionTitle || 'فتح شكوى').slice(0, 45));

        const fields = (type.fields || []).slice(0, 5);

        if (!fields.length) {
          fields.push({
            label: 'اكتب تفاصيل الشكوى',
            placeholder: 'اكتب التفاصيل هنا',
            style: 'Paragraph',
            required: true
          });
        }

        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];

          const input = new TextInputBuilder()
            .setCustomId(`answer_${i}`)
            .setLabel((field.label || `السؤال ${i + 1}`).slice(0, 45))
            .setPlaceholder((field.placeholder || 'اكتب إجابتك').slice(0, 100))
            .setStyle(
              field.style === 'Paragraph'
                ? TextInputStyle.Paragraph
                : TextInputStyle.Short
            )
            .setRequired(field.required !== false);

          modal.addComponents(
            new ActionRowBuilder().addComponents(input)
          );
        }

        return interaction.showModal(modal);
      }

      // Escalate ticket to Owner (per-type toggle + role & category)
      if (interaction.customId === 'escalate_to_owner') {
        const lockRes = await runWithLock(`escalate:${interaction.channelId}`, async () => {
          const ticket = await getTicket(interaction.channelId);
          if (!ticket || ticket.status !== 'open') {
            return interaction.reply({
              content: 'هذه الشكوى مغلقة أو غير موجودة.',
              ephemeral: true
            });
          }

          const type = getTicketType(ticket.type_id);
          if (!isOwnerEscalationEnabledForType(type)) {
            return interaction.reply({
              content: 'ميزة التحويل إلى أونر غير مفعّلة لهذا النوع من الشكاوى.',
              ephemeral: true
            });
          }

          if (!isStaffMember(interaction.member, type)) {
            return interaction.reply({
              content: 'ليس لديك صلاحية تحويل هذه الشكوى إلى أونر.',
              ephemeral: true
            });
          }

          if (ticket.escalated_to_owner) {
            return interaction.reply({
              content: 'تم تحويل هذه الشكوى إلى أونر مسبقاً.',
              ephemeral: true
            });
          }

          const { ownerRoleId, ownerCategoryId } = resolveOwnerEscalationTarget(type);
          if (!ownerRoleId || !ownerCategoryId) {
            return interaction.reply({
              content: 'لم يتم تحديد **رول الأونر** أو **كاتكوري التحويل** من لوحة التحكم بعد.',
              ephemeral: true
            });
          }

          await interaction.deferReply({ ephemeral: true });

          const dbClient = await pool.connect();
          try {
            await dbClient.query('BEGIN');
            const lockedRow = await dbClient.query(
              'SELECT escalated_to_owner FROM tickets WHERE channel_id = $1 FOR UPDATE',
              [interaction.channelId]
            );
            if (!lockedRow.rows.length || lockedRow.rows[0].escalated_to_owner) {
              await dbClient.query('ROLLBACK');
              return interaction.editReply('تم تحويل هذه الشكوى إلى أونر مسبقاً.');
            }

            const targetCategory = await interaction.guild.channels.fetch(ownerCategoryId).catch(() => null);
            if (!targetCategory || targetCategory.type !== ChannelType.GuildCategory) {
              await dbClient.query('ROLLBACK');
              return interaction.editReply('الكاتكوري المحدد للتحويل غير موجود أو غير صالح.');
            }

            if (interaction.channel) {
              await interaction.channel.permissionOverwrites.edit(ownerRoleId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                AttachFiles: true,
                EmbedLinks: true
              });

              await interaction.channel.setParent(targetCategory.id, { lockPermissions: false });
            }

            await dbClient.query(`
              UPDATE tickets
              SET escalated_to_owner = TRUE,
                  escalated_at = NOW(),
                  escalated_by = $1,
                  escalated_by_tag = $2
              WHERE channel_id = $3
            `, [
              interaction.user.id,
              interaction.user.tag,
              interaction.channelId
            ]);

            await dbClient.query('COMMIT');
          } catch (err) {
            await dbClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            dbClient.release();
          }

          await recordTicketView(interaction.channelId, interaction.user);
          await addStaffAction(
            interaction.channelId,
            interaction.user,
            'تحويل إلى أونر',
            `الرول: ${ownerRoleId} | الكاتكوري: ${ownerCategoryId}`
          );

          const refreshed = await getTicket(interaction.channelId);
          if (refreshed) {
            activeTickets.set(interaction.channelId, refreshed);
          }

          if (interaction.channel) {
            await interaction.channel.send({
              content: `<@&${ownerRoleId}>`,
              embeds: [
                new EmbedBuilder()
                  .setColor(0xF59E0B)
                  .setTitle('👑 تم تحويل الشكوى إلى أونر')
                  .setDescription(
                    `**بواسطة:** <@${interaction.user.id}>\n` +
                    `**رول الأونر:** <@&${ownerRoleId}>\n` +
                    `**الكاتكوري الجديد:** <#${ownerCategoryId}>`
                  )
                  .setTimestamp()
              ],
              allowedMentions: {
                roles: [ownerRoleId]
              }
            });
          }

          return interaction.editReply('تم تحويل الشكوى إلى أونر ونقلها إلى الكاتكوري المحدد بنجاح.');
        });

        if (lockRes.locked) {
          return interaction.reply({
            content: 'جاري تنفيذ عملية التحويل حالياً...',
            ephemeral: true
          });
        }
        return;
      }

      // Record staff view / inspection
      if (interaction.customId === 'view_ticket_log') {
        const ticket = await getTicket(interaction.channelId);
        if (!ticket) {
          return interaction.reply({
            content: 'لم أجد بيانات هذه الشكوى.',
            ephemeral: true
          });
        }

        const type = getTicketType(ticket.type_id);
        if (!isStaffMember(interaction.member, type)) {
          return interaction.reply({
            content: 'هذا الزر مخصص للإدارة فقط.',
            ephemeral: true
          });
        }

        await recordTicketView(interaction.channelId, interaction.user);
        await addStaffAction(
          interaction.channelId,
          interaction.user,
          'تسجيل مشاهدة',
          'تم توثيق اطلاع الإداري على الشكوى'
        );

        return interaction.reply({
          content: `👁️ تم تسجيل اطلاعك على الشكوى #${ticket.ticket_number} في ${formatDate(new Date())}.`,
          ephemeral: true
        });
      }

      // Claim ticket & enable staff writing
      if (interaction.customId === 'claim_ticket') {
        const lockRes = await runWithLock(`claim:${interaction.channelId}`, async () => {
          const ticket = await getTicket(interaction.channelId);

          if (!ticket || ticket.status !== 'open') {
            return interaction.reply({
              content: 'هذه الشكوى غير متاحة للاستلام.',
              ephemeral: true
            });
          }

          const type = getTicketType(ticket.type_id);

          if (!isStaffMember(interaction.member, type)) {
            return interaction.reply({
              content: 'ليس لديك صلاحية استلام هذه الشكوى.',
              ephemeral: true
            });
          }

          if (ticket.claimed_by) {
            return interaction.reply({
              content: `تم استلام الشكوى مسبقاً بواسطة <@${ticket.claimed_by}>.`,
              ephemeral: true
            });
          }

          const nowIso = new Date().toISOString();

          const dbClient = await pool.connect();
          try {
            await dbClient.query('BEGIN');
            const current = await dbClient.query(
              'SELECT claimed_by FROM tickets WHERE channel_id = $1 AND status = $2 FOR UPDATE',
              [interaction.channelId, 'open']
            );
            if (!current.rows.length) {
              await dbClient.query('ROLLBACK');
              return interaction.reply({
                content: 'هذه الشكوى غير متاحة للاستلام.',
                ephemeral: true
              });
            }
            if (current.rows[0].claimed_by) {
              await dbClient.query('ROLLBACK');
              return interaction.reply({
                content: `تم استلام الشكوى مسبقاً بواسطة <@${current.rows[0].claimed_by}>.`,
                ephemeral: true
              });
            }

            await dbClient.query(`
              UPDATE tickets
              SET claimed_by = $1,
                  claimed_by_tag = $2,
                  claimed_at = $3
              WHERE channel_id = $4
            `, [
              interaction.user.id,
              interaction.user.tag,
              nowIso,
              interaction.channelId
            ]);

            await dbClient.query('COMMIT');
          } catch (err) {
            await dbClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            dbClient.release();
          }

          await recordTicketView(interaction.channelId, interaction.user);
          await addStaffAction(
            interaction.channelId,
            interaction.user,
            'استلام الشكوى',
            'تم استلام الشكوى من قبل الإدارة وتفعيل الكتابة للإدارة'
          );

          await setStaffSendPermission(interaction.channel, type, true);

          activeTickets.set(interaction.channelId, {
            ...ticket,
            claimed_by: interaction.user.id,
            claimed_by_tag: interaction.user.tag,
            claimed_at: nowIso
          });

          return interaction.reply({
            content: `تم استلام الشكوى بواسطة <@${interaction.user.id}> وتم تفعيل الكتابة للإدارة.`,
            allowedMentions: { users: [interaction.user.id] }
          });
        });

        if (lockRes.locked) {
          return interaction.reply({
            content: 'جاري معالجة طلب الاستلام...',
            ephemeral: true
          });
        }
        return;
      }

      // Reopen ticket (specific role/permission + reason modal)
      if (interaction.customId === 'reopen_ticket') {
        const ticket = await getTicket(interaction.channelId);
        if (!ticket) {
          return interaction.reply({
            content: 'لم أجد بيانات هذه الشكوى.',
            ephemeral: true
          });
        }

        if (ticket.status !== 'closed') {
          return interaction.reply({
            content: 'هذه الشكوى مفتوحة بالفعل.',
            ephemeral: true
          });
        }

        const type = getTicketType(ticket.type_id);
        if (!canReopenTicket(interaction.member, type)) {
          return interaction.reply({
            content: 'ليس لديك الصلاحية المحددة لإعادة فتح هذه الشكوى.',
            ephemeral: true
          });
        }

        const modal = new ModalBuilder()
          .setCustomId('reopen_ticket_reason')
          .setTitle('إعادة فتح الشكوى');

        const reasonInput = new TextInputBuilder()
          .setCustomId('reopen_reason')
          .setLabel('سبب إعادة فتح الشكوى')
          .setPlaceholder('اكتب سبب إعادة فتح التذكرة')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500);

        modal.addComponents(
          new ActionRowBuilder().addComponents(reasonInput)
        );

        return interaction.showModal(modal);
      }

      // Ticket owner rating buttons (1 to 5 stars)
      if (interaction.customId.startsWith('rate_ticket:')) {
        const parts = interaction.customId.split(':');
        const targetChannelId = parts[1];
        const score = Number(parts[2]);

        const ticket = await getTicket(targetChannelId);
        if (!ticket) {
          return interaction.reply({
            content: 'لم أجد بيانات هذه الشكوى.',
            ephemeral: true
          });
        }

        if (interaction.user.id !== ticket.user_id) {
          return interaction.reply({
            content: 'التقييم متاح لصاحب الشكوى فقط.',
            ephemeral: true
          });
        }

        if (!Number.isInteger(score) || score < 1 || score > 5) {
          return interaction.reply({
            content: 'قيمة التقييم غير صالحة.',
            ephemeral: true
          });
        }

        pendingRatings.set(interaction.user.id, {
          channelId: targetChannelId,
          rating: score
        });

        const modal = new ModalBuilder()
          .setCustomId(`submit_rating:${targetChannelId}:${score}`)
          .setTitle(`تقييم الإدارة (${score} / 5)`);

        const commentInput = new TextInputBuilder()
          .setCustomId('rating_comment')
          .setLabel('ملاحظتك عن تعامل الإدارة (اختياري)')
          .setPlaceholder('اكتب رأيك أو ملاحظتك حول تعامل الإداري')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500);

        modal.addComponents(
          new ActionRowBuilder().addComponents(commentInput)
        );

        return interaction.showModal(modal);
      }

      // Record ticket (only after closing) and delete channel after 5 seconds
      if (interaction.customId === 'record_ticket') {
        const lockRes = await runWithLock(`record:${interaction.channelId}`, async () => {
          const ticket = await getTicket(interaction.channelId);

          if (!ticket) {
            return interaction.reply({
              content: 'لم أجد بيانات هذه الشكوى.',
              ephemeral: true
            });
          }

          const type = getTicketType(ticket.type_id);

          if (!isStaffMember(interaction.member, type)) {
            return interaction.reply({
              content: 'ليس لديك صلاحية تسجيل الشكوى.',
              ephemeral: true
            });
          }

          if (ticket.status !== 'closed') {
            return interaction.reply({
              content: 'تعذر عليك إغلاق الشكوى أولاً',
              ephemeral: true
            });
          }

          if (ticket.is_recording) {
            return interaction.reply({
              content: 'جاري تسجيل هذه الشكوى وحذف الروم مسبقاً.',
              ephemeral: true
            });
          }

          await interaction.deferReply({ ephemeral: true });

          await pool.query(
            'UPDATE tickets SET is_recording = TRUE WHERE channel_id = $1',
            [interaction.channelId]
          );

          await addStaffAction(
            interaction.channelId,
            interaction.user,
            'تسجيل التذكرة',
            'تم إرسال سجل التذكرة وجدولة حذف الروم بعد 5 ثواني'
          );

          const sent = await sendArchiveToLogChannel(
            interaction.guild,
            interaction.channelId,
            'تسجيل التذكرة'
          );

          if (!sent) {
            await pool.query(
              'UPDATE tickets SET is_recording = FALSE WHERE channel_id = $1',
              [interaction.channelId]
            );
            return interaction.editReply(
              'تعذر إرسال سجل التذكرة. تحقق من روم السجل وصلاحيات البوت.'
            );
          }

          await interaction.editReply(
            'تم إرسال سجل التذكرة إلى الروم المحدد، وسيتم حذف الروم بعد 5 ثواني.'
          );

          const targetChannel = interaction.channel;
          if (targetChannel) {
            await targetChannel.send({
              content: '✅ تم تسجيل التذكرة وإرسال السجل، سيتم حذف هذا الروم خلال **5 ثواني**...'
            }).catch(() => {});

            activeTickets.delete(interaction.channelId);

            setTimeout(async () => {
              try {
                await targetChannel.delete('تم تسجيل التذكرة وحذف الروم بعد 5 ثواني');
              } catch (err) {
                console.error('Channel delete after record error:', err);
              }
            }, 5000);
          }
        });

        if (lockRes.locked) {
          return interaction.reply({
            content: 'جاري تسجيل هذه الشكوى حالياً...',
            ephemeral: true
          });
        }
        return;
      }

      // Close ticket (staff only, ticket owner cannot close)
      if (interaction.customId === 'close_ticket') {
        const ticket = await getTicket(interaction.channelId);

        if (!ticket || ticket.status !== 'open') {
          return interaction.reply({
            content: 'هذه الشكوى مغلقة أو غير موجودة.',
            ephemeral: true
          });
        }

        if (interaction.user.id === ticket.user_id) {
          return interaction.reply({
            content: 'لا يمكنك إغلاق الشكوى، الإغلاق مخصص للإدارة فقط.',
            ephemeral: true
          });
        }

        const type = getTicketType(ticket.type_id);

        if (!isStaffMember(interaction.member, type)) {
          return interaction.reply({
            content: 'ليس لديك صلاحية إغلاق هذه الشكوى.',
            ephemeral: true
          });
        }

        const modal = new ModalBuilder()
          .setCustomId('close_ticket_reason')
          .setTitle('إغلاق الشكوى');

        const reason = new TextInputBuilder()
          .setCustomId('close_reason')
          .setLabel('سبب إغلاق الشكوى')
          .setPlaceholder('اكتب سبب الإغلاق')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(
          new ActionRowBuilder().addComponents(reason)
        );

        return interaction.showModal(modal);
      }
    }

    // ----------------------------
    // MODALS
    // ----------------------------

    if (interaction.isModalSubmit()) {

      // Submit new ticket (staff cannot write until claimed; owner can write immediately)
      if (interaction.customId.startsWith('submit_ticket:')) {
        await interaction.deferReply({ ephemeral: true });

        const typeId = interaction.customId.split(':')[1];
        const type = getTicketType(typeId);

        if (!type) {
          return interaction.editReply('نوع الشكوى غير موجود.');
        }

        const allowedRoles = type.allowedRoleIds || [];
        if (
          allowedRoles.length &&
          !allowedRoles.some(id => interaction.member.roles.cache.has(id))
        ) {
          return interaction.editReply('لا تملك صلاحية فتح هذا النوع من الشكاوى.');
        }

        const answers = [];
        const fields = (type.fields || []).slice(0, 5);

        if (!fields.length) {
          answers.push({
            label: 'تفاصيل الشكوى',
            value: interaction.fields.getTextInputValue('answer_0')
          });
        } else {
          for (let i = 0; i < fields.length; i++) {
            answers.push({
              label: fields[i].label || `السؤال ${i + 1}`,
              value: interaction.fields.getTextInputValue(`answer_${i}`)
            });
          }
        }

        const category = type.categoryId
          ? await interaction.guild.channels.fetch(type.categoryId).catch(() => null)
          : null;

        const safeName = interaction.user.username
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(0, 12) || 'user';

        const permissionOverwrites = [
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
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks
            ]
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks
            ]
          }
        ];

        for (const roleId of (type.staffRoleIds || [])) {
          permissionOverwrites.push({
            id: roleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory
            ],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks
            ]
          });
        }

        let createdChannel = null;
        let ticketNumber = null;
        const dbClient = await pool.connect();

        try {
          await dbClient.query('BEGIN');

          if (!cachedConfig?.allowMultipleTicketsPerUser) {
            const existingOpen = await dbClient.query(
              'SELECT channel_id FROM tickets WHERE guild_id = $1 AND user_id = $2 AND status = $3 LIMIT 1',
              [interaction.guildId, interaction.user.id, 'open']
            );
            if (existingOpen.rowCount > 0) {
              await dbClient.query('ROLLBACK');
              return interaction.editReply({
                content: `لديك شكوى مفتوحة بالفعل في <#${existingOpen.rows[0].channel_id}>.`
              });
            }
          }

          const counterRes = await dbClient.query(`
            UPDATE ticket_counter
            SET last_number = last_number + 1
            WHERE id = 1
            RETURNING last_number
          `);
          ticketNumber = Number(counterRes.rows[0].last_number);

          createdChannel = await interaction.guild.channels.create({
            name: `شكوى-${ticketNumber}-${safeName}`.slice(0, 95),
            type: ChannelType.GuildText,
            parent: category?.type === ChannelType.GuildCategory
              ? category.id
              : undefined,
            permissionOverwrites
          });

          await dbClient.query(`
            INSERT INTO tickets (
              ticket_number,
              guild_id,
              channel_id,
              user_id,
              user_tag,
              type_id,
              type_name,
              answers
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          `, [
            ticketNumber,
            interaction.guildId,
            createdChannel.id,
            interaction.user.id,
            interaction.user.tag,
            type.id,
            type.sectionTitle || 'شكوى',
            JSON.stringify(answers)
          ]);

          await dbClient.query('COMMIT');
        } catch (err) {
          await dbClient.query('ROLLBACK').catch(() => {});
          if (createdChannel) {
            await createdChannel.delete().catch(() => {});
          }
          throw err;
        } finally {
          dbClient.release();
        }

        const ticketData = {
          channel_id: createdChannel.id,
          ticket_number: ticketNumber,
          user_id: interaction.user.id,
          user_tag: interaction.user.tag,
          type_id: type.id,
          type_name: type.sectionTitle || 'شكوى',
          answers,
          status: 'open',
          escalated_to_owner: false,
          created_at: new Date().toISOString()
        };

        activeTickets.set(createdChannel.id, ticketData);

        const answerText = answers.map(a =>
          `**${a.label}:**\n${a.value}`
        ).join('\n\n');

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`شكوى جديدة #${ticketNumber}`)
          .setDescription(
            `**صاحب الشكوى:** <@${interaction.user.id}>\n` +
            `**نوع الشكوى:** ${type.sectionTitle || 'شكوى'}\n\n` +
            `${answerText}\n\n` +
            `${type.evidenceNote || ''}`
          )
          .setFooter({ text: 'نظام الشكاوى - OS Shop' })
          .setTimestamp();

        const mentionRoles = (type.staffRoleIds || [])
          .map(id => `<@&${id}>`)
          .join(' ');

        const openingMessage = await createdChannel.send({
          content: mentionRoles || `<@${interaction.user.id}>`,
          embeds: [embed],
          components: buildTicketControlRows(type),
          allowedMentions: {
            users: [interaction.user.id],
            roles: type.staffRoleIds || []
          }
        });

        await saveMessage(openingMessage);

        await addStaffAction(
          createdChannel.id,
          interaction.user,
          'فتح الشكوى',
          `تم فتح الشكوى رقم ${ticketNumber}`
        );

        return interaction.editReply({
          content: `تم فتح شكواك بنجاح: <#${createdChannel.id}>`
        });
      }

      // Reopen ticket modal
      if (interaction.customId === 'reopen_ticket_reason') {
        await interaction.deferReply({ ephemeral: true });

        const ticket = await getTicket(interaction.channelId);
        if (!ticket) {
          return interaction.editReply('لم أجد بيانات هذه الشكوى.');
        }

        if (ticket.status !== 'closed') {
          return interaction.editReply('هذه الشكوى مفتوحة بالفعل.');
        }

        const type = getTicketType(ticket.type_id);
        if (!canReopenTicket(interaction.member, type)) {
          return interaction.editReply('ليس لديك الصلاحية المحددة لإعادة فتح هذه الشكوى.');
        }

        const reopenReason = interaction.fields.getTextInputValue('reopen_reason');

        await pool.query(`
          UPDATE tickets
          SET status = 'open',
              reopened_count = COALESCE(reopened_count, 0) + 1,
              last_reopened_at = NOW(),
              last_reopened_by = $1,
              last_reopened_by_tag = $2,
              reopen_reason = $3,
              is_recording = FALSE
          WHERE channel_id = $4
        `, [
          interaction.user.id,
          interaction.user.tag,
          reopenReason,
          interaction.channelId
        ]);

        await recordTicketView(interaction.channelId, interaction.user);
        await addStaffAction(
          interaction.channelId,
          interaction.user,
          'إعادة فتح الشكوى',
          reopenReason
        );

        const refreshed = await getTicket(interaction.channelId);
        activeTickets.set(interaction.channelId, refreshed);

        if (interaction.channel && ticket.user_id) {
          await interaction.channel.permissionOverwrites.edit(ticket.user_id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true
          }).catch(err => {
            console.error('Could not restore owner permission on reopen:', err);
          });
        }

        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x23A55A)
              .setTitle('🔓 تم إعادة فتح الشكوى')
              .setDescription(
                `**بواسطة:** <@${interaction.user.id}>\n` +
                `**السبب:** ${reopenReason}\n` +
                `تمت إعادة تفعيل الكتابة لصاحب الشكوى.`
              )
              .setTimestamp()
          ]
        });

        return interaction.editReply('تمت إعادة فتح الشكوى بنجاح.');
      }

      // Rating submission modal
      if (interaction.customId.startsWith('submit_rating:')) {
        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split(':');
        const targetChannelId = parts[1];
        const score = Number(parts[2]);
        const comment = interaction.fields.getTextInputValue('rating_comment') || '';

        const ticket = await getTicket(targetChannelId);
        if (!ticket) {
          return interaction.editReply('لم أجد بيانات هذه الشكوى.');
        }

        if (interaction.user.id !== ticket.user_id) {
          return interaction.editReply('التقييم متاح لصاحب الشكوى فقط.');
        }

        await pool.query(`
          UPDATE tickets
          SET rating = $1,
              rating_comment = $2,
              rated_at = NOW()
          WHERE channel_id = $3
        `, [
          score,
          comment,
          targetChannelId
        ]);

        pendingRatings.delete(interaction.user.id);

        await addStaffAction(
          targetChannelId,
          interaction.user,
          'تقييم الإدارة',
          `التقييم: ${score}/5${comment ? ` - ${comment}` : ''}`
        );

        const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
        if (targetChannel && targetChannel.isTextBased()) {
          await targetChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xF59E0B)
                .setTitle('⭐ تم تسجيل تقييم صاحب الشكوى')
                .setDescription(
                  `**التقييم:** ${score} / 5\n` +
                  (comment ? `**الملاحظة:** ${comment}` : '**الملاحظة:** بدون ملاحظات إضافية')
                )
                .setTimestamp()
            ]
          }).catch(() => null);
        }

        return interaction.editReply('شكراً لتقييمك، تم حفظ التقييم بنجاح.');
      }

      // Close reason modal (keep channel, block owner from sending messages, compute durations, prompt rating)
      if (interaction.customId === 'close_ticket_reason') {
        await interaction.deferReply({ ephemeral: true });

        const ticket = await getTicket(interaction.channelId);

        if (!ticket || ticket.status !== 'open') {
          return interaction.editReply('هذه الشكوى مغلقة مسبقاً أو غير موجودة.');
        }

        if (interaction.user.id === ticket.user_id) {
          return interaction.editReply('لا يمكنك إغلاق الشكوى، الإغلاق مخصص للإدارة فقط.');
        }

        const type = getTicketType(ticket.type_id);
        if (!isStaffMember(interaction.member, type)) {
          return interaction.editReply('ليس لديك صلاحية إغلاق هذه الشكوى.');
        }

        const reason = interaction.fields.getTextInputValue('close_reason');
        const closedAtIso = new Date().toISOString();

        await pool.query(`
          UPDATE tickets
          SET status = 'closed',
              closed_at = $1,
              closed_by = $2,
              closed_by_tag = $3,
              close_reason = $4
          WHERE channel_id = $5
        `, [
          closedAtIso,
          interaction.user.id,
          interaction.user.tag,
          reason,
          interaction.channelId
        ]);

        await addStaffAction(
          interaction.channelId,
          interaction.user,
          'إغلاق الشكوى',
          reason
        );

        const updatedTicket = await getTicket(interaction.channelId);
        const durations = getTicketDurations(updatedTicket);

        activeTickets.set(interaction.channelId, updatedTicket);

        if (interaction.channel && ticket.user_id) {
          await interaction.channel.permissionOverwrites.edit(ticket.user_id, {
            SendMessages: false
          }).catch(err => {
            console.error('Could not block ticket owner from sending messages:', err);
          });
        }

        const archiveSent = await sendArchiveToLogChannel(
          interaction.guild,
          interaction.channelId,
          'الأرشيف النهائي بعد الإغلاق'
        );

        await interaction.editReply(
          archiveSent
            ? 'تم إغلاق الشكوى ومنع صاحبها من الكتابة، وتم إرسال الأرشيف النهائي.'
            : 'تم إغلاق الشكوى ومنع صاحبها من الكتابة، لكن تعذر إرسال الأرشيف. راجع إعدادات روم السجل.'
        );

        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xDA373C)
              .setTitle('تم إغلاق الشكوى')
              .setDescription(
                `**بواسطة:** <@${interaction.user.id}>\n` +
                `**السبب:** ${reason}\n` +
                `**مدة المعالجة الكلية:** ${durations.totalProcess}\n` +
                `**مدة المعالجة بعد الاستلام:** ${durations.claimToClose}\n` +
                `تم تعطيل الكتابة لصاحب الشكوى، والروم جاهز للتسجيل أو إعادة الفتح.`
              )
              .setTimestamp()
          ]
        });

        // Rating prompt for the ticket owner
        await interaction.channel.send({
          content: `<@${ticket.user_id}> يرجى تقييم تعامل الإدارة مع شكواك:`,
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('تقييم تعامل الإدارة')
              .setDescription('اختر تقييمك من **1** إلى **5** نجوم عبر الأزرار أدناه.')
          ],
          components: [buildRatingRow(interaction.channelId)],
          allowedMentions: { users: [ticket.user_id] }
        }).catch(() => null);

        return;
      }
    }

  } catch (error) {
    console.error('Interaction error:', error);

    const message = 'حدث خطأ أثناء تنفيذ العملية. راجع سجلات البوت.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: message,
        ephemeral: true
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// ================================
// GRACEFUL SHUTDOWN & LOGIN
// ================================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  await new Promise((resolve) => httpServer.close(resolve));
  await client.destroy().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

client.login(TOKEN).catch(error => {
  console.error('Discord login failed:', error);
});
