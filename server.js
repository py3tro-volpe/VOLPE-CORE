// src/server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const rawBody = require('raw-body');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { Client, GatewayIntentBits, EmbedBuilder, Collection } = require('discord.js');
const { loadDB, saveDB, appendLog } = require('./src/db-system'); // db-system continua dentro de src

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CANAL_PROMOCOES = process.env.CANAL_PROMOCOES;
const LOG_CHANNEL = process.env.LOG_CHANNEL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ALLOW_TEST = process.env.ALLOW_TEST_COMMANDS !== 'false';

// RANKS
const RANKS = [
  { amount: 1, role: '1437232831112941589' },
  { amount: 50, role: '1437233140757168288' },
  { amount: 100, role: '1437233233086517329' },
  { amount: 500, role: '1437233800537968656' },
  { amount: 1000, role: '1437234287761166396' },
  { amount: 5000, role: '1437234433081212938' },
  { amount: 10000, role: '1437234657191137311' },
  { amount: 15000, role: '1437234823684161536' },
  { amount: 20000, role: '1437234957314560070' }
];

// logger
const winston = require('winston');
const logsDir = path.join(__dirname);
const winLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'service.log'), maxsize: 5 * 1024 * 1024 }),
    new winston.transports.Console()
  ]
});

const app = express();
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json({ limit: '128kb' }));
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.get('/', (req, res) => res.send('OK'));

// HMAC helper
function computeHmacHex(buf, secret) {
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

async function readRawBody(req) {
  const len = req.headers['content-length'];
  return rawBody(req, { length: len, limit: '256kb', encoding: 'utf8' });
}

// webhook route...
// (mantenha todo o bloco /easebot igual ao seu código original)

// ------------------------
// Commands loader (fora da pasta src)
const commandsPath = path.join(__dirname, '..', 'commands'); // volta uma pasta para achar commands
const commandFiles = fs.existsSync(commandsPath) ? fs.readdirSync(commandsPath).filter(f => f.endsWith('.js')) : [];
const commands = new Collection();
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  commands.set(cmd.data.name, cmd);
}

// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', () => {
  winLogger.info(`Discord ready: ${client.user.tag}`);
  appendLog({ ts: new Date().toISOString(), type: 'client_ready', user: client.user.tag });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.get(interaction.commandName);
  if (!cmd) return interaction.reply({ content: 'Comando não encontrado', ephemeral: true });

  try {
    await cmd.execute(interaction, { loadDB, saveDB, appendLog, RANKS });

    // pós-processamento do /comprar...
    if (interaction.commandName === 'comprar') {
      const userId = interaction.user.id;
      const db = loadDB();
      let bestRank = null;
      if (db.users[userId]) for (const r of RANKS) if (db.users[userId].total >= r.amount) bestRank = r;

      if (bestRank) {
        try {
          const guild = client.guilds.cache.get(GUILD_ID);
          if (guild) {
            const member = await guild.members.fetch(userId).catch(()=>null);
            if (member && !member.roles.cache.has(bestRank.role)) {
              for (const r of RANKS) if (member.roles.cache.has(r.role)) await member.roles.remove(r.role).catch(()=>{});
              await member.roles.add(bestRank.role).catch(()=>{});
              appendLog({ ts: new Date().toISOString(), type: 'role_added_manual', userId, role: bestRank.role });

              // notificando canal de promoções
              const channel = guild.channels.cache.get(CANAL_PROMOCOES) || guild.channels.cache.find(c => c.id === CANAL_PROMOCOES);
              if (channel && channel.isTextBased()) {
                channel.send({ embeds: [{ title: `${member.user.username} foi promovido`, description: `Total gasto: R$ ${db.users[userId].total.toFixed(2)}\nNovo cargo: <@&${bestRank.role}>` }] }).catch(()=>{});
              }
            }
          }
        } catch (err) { appendLog({ ts: new Date().toISOString(), type: 'post_command_error', error: String(err) }); }
      }
    }
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), type: 'command_error', command: interaction.commandName, error: String(err) });
    console.error(err);
    interaction.reply({ content: 'Erro ao executar comando', ephemeral: true });
  }
});

// start express & login
app.listen(PORT, () => { winLogger.info(`Express listening on ${PORT}`); });
client.login(TOKEN).catch(err => {
  winLogger.error('Discord login failed: ' + String(err));
  process.exit(1);
});