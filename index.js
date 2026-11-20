const http = require('http');

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot is running');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT}`);
  });

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CONFIG_URL = process.env.CONFIG_URL;

if (!TOKEN) {
  console.error('TOKEN is missing in environment variables!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

let cachedConfig = null;
let lastFetch = 0;

async function getConfig() {
  const now = Date.now();
  if (cachedConfig && now - lastFetch < 30000) {
    return cachedConfig;
  }
  if (!CONFIG_URL) {
    return {};
  }
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cfg = data && data.config ? data.config : data || {};
    cachedConfig = cfg;
    lastFetch = now;
    return cachedConfig;
  } catch (err) {
    console.error('خطأ بجلب الإعدادات من CONFIG_URL:', err);
    return cachedConfig || {};
  }
}

async function syncGuildMeta(guild) {
  if (!CONFIG_URL || !guild) return;
  try {
    await guild.channels.fetch();
    await guild.roles.fetch();

    const categories = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((c) => ({ id: c.id, name: c.name }));

    const channels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ id: c.id, name: c.name }));

    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));

    await fetch(CONFIG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'sync_meta',
        categories,
        channels,
        roles,
      }),
    });
    console.log('تم مزامنة الشاتات والكاتكوريات والرولات مع لوحة التحكم.');
  } catch (err) {
    console.error('خطأ بمزامنة بيانات السيرفر:', err);
  }
}

function formatText(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : ''
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('إرسال رسالة نصية عادية إلى شات تختاره من القائمة')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('اختر الشات الذي تريد إرسال الرسالة إليه')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('اكتب نص الرسالة العادية بدون Embed')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('complaint')
    .setDescription('فتح روم شكوى خاص بك')
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('اكتب عنوان أو ملخص مختصر للشكوى')
        .setRequired(false)
    ),
].map((command) => command.toJSON());

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`البوت شغال باسم: ${readyClient.user.tag}`);

  if (CLIENT_ID && GUILD_ID) {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('تم تسجيل الأوامر بنجاح!');
    } catch (error) {
      console.error('خطأ أثناء تسجيل الأوامر:', error);
    }

    const guild = readyClient.guilds.cache.get(GUILD_ID) || (await readyClient.guilds.fetch(GUILD_ID).catch(() => null));
    if (guild) {
      await syncGuildMeta(guild);
      setInterval(() => syncGuildMeta(guild), 5 * 60 * 1000);
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = await getConfig();
  if (cfg.welcomeEnabled === false || !cfg.welcomeChannelId) return;

  const channel = member.guild.channels.cache.get(cfg.welcomeChannelId);
  if (!channel || !channel.isTextBased()) return;

  const text = formatText(
    cfg.welcomeMessage || 'أهلاً بك {user} في **{server}**! أنت العضو رقم **{count}**.',
    {
      user: `<@${member.id}>`,
      server: member.guild.name,
      count: member.guild.memberCount,
      tag: member.user.tag,
    }
  );

  try {
    await channel.send({ content: text });
  } catch (err) {
    console.error('خطأ بإرسال رسالة الترحيب:', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const cfg = await getConfig();
  if (cfg.goodbyeEnabled === false || !cfg.goodbyeChannelId) return;

  const channel = member.guild.channels.cache.get(cfg.goodbyeChannelId);
  if (!channel || !channel.isTextBased()) return;

  const text = formatText(
    cfg.goodbyeMessage || 'غادر السيرفر **{tag}**، العدد الحالي: **{count}**.',
    {
      user: `<@${member.id}>`,
      server: member.guild.name,
      count: member.guild.memberCount,
      tag: member.user.tag || member.user.username,
    }
  );

  try {
    await channel.send({ content: text });
  } catch (err) {
    console.error('خطأ بإرسال رسالة التوديع:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'send') {
    const targetChannel = interaction.options.getChannel('channel');
    const messageText = interaction.options.getString('message');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await targetChannel.send({ content: messageText });
      await interaction.editReply({
        content: `تم إرسال رسالتك إلى <#${targetChannel.id}>`,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply({
        content: 'تعذر الإرسال، تأكد من صلاحيات البوت في هذا الشات.',
      });
    }
    return;
  }

  if (interaction.commandName === 'complaint') {
    if (!interaction.guild) {
      await interaction.reply({
        content: 'هذا الأمر يعمل داخل السيرفر فقط.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const cfg = await getConfig();
      const roleIds = String(cfg.mentionRoleIds || '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^\d{17,20}$/.test(id));

      const permissionOverwrites = [
        {
          id: interaction.guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ];

      for (const roleId of roleIds) {
        if (interaction.guild.roles.cache.has(roleId)) {
          permissionOverwrites.push({
            id: roleId,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          });
        }
      }

      const cleanName = interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '')
        .slice(0, 15) || 'user';

      const channelOptions = {
        name: `شكوى-${cleanName}`,
        type: ChannelType.GuildText,
        permissionOverwrites,
      };

      if (cfg.ticketCategoryId && /^\d{17,20}$/.test(String(cfg.ticketCategoryId).trim())) {
        channelOptions.parent = String(cfg.ticketCategoryId).trim();
      }

      const ticketChannel = await interaction.guild.channels.create(channelOptions);

      const mentions = roleIds.map((id) => `<@&${id}>`).join(' ');
      const bodyText = formatText(
        cfg.ticketMessage || 'أهلاً {user}، اكتب تفاصيل شكواك هنا وسيتم الرد عليك قريباً.',
        {
          user: `<@${interaction.user.id}>`,
          server: interaction.guild.name,
        }
      );

      const reason = interaction.options.getString('reason');
      const reasonLine = reason ? `\n**الموضوع:** ${reason}` : '';
      const finalMessage = `${mentions ? `${mentions}\n` : ''}${bodyText}${reasonLine}`;

      await ticketChannel.send({ content: finalMessage });

      await interaction.editReply({
        content: `تم فتح شكواك في <#${ticketChannel.id}>`,
      });
    } catch (err) {
      console.error('خطأ بفتح التكت:', err);
      await interaction.editReply({
        content: 'تعذر فتح الشكوى، تأكد من صلاحية Manage Channels للبوت ومن صحة ID الكاتكوري والرولات.',
      });
    }
  }
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

client.login(TOKEN);
