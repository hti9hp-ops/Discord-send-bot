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
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error('TOKEN is missing in environment variables!');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('إرسال رسالة نصية عادية إلى شات تختاره من القائمة')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('اختر الشات الذي تريد إرسال الرسالة إليه')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('اكتب نص الرسالة العادية بدون Embed')
        .setRequired(true)
    ),
].map((command) => command.toJSON());

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`البوت شغال باسم: ${readyClient.user.tag}`);

  if (CLIENT_ID && GUILD_ID) {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('تم تسجيل أمر /send بنجاح!');
    } catch (error) {
      console.error('خطأ أثناء تسجيل الأمر:', error);
    }
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
  }
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

client.login(TOKEN);
