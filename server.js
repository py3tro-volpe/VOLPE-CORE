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
const { loadDB, saveDB, appendLog, readLogs, createBackup } = require('./db-system');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CANAL_PROMOCOES = process.env.CANAL_PROMOCOES;
const LOG_CHANNEL = process.env.LOG_CHANNEL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ALLOW_TEST = process.env.ALLOW_TEST_COMMANDS !== 'false';

// RANKS (mesma lista)
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

// logger (file + console) using simple file writes wrapped
const winston = require('winston');
const logsDir = path.join(__dirname);
const winLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)),
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

// Webhook route
app.post('/easebot', webhookLimiter, async (req, res) => {
  try {
    if (!WEBHOOK_SECRET) {
      winLogger.warn('WEBHOOK_SECRET not configured');
      appendLog({ ts: new Date().toISOString(), type: 'hmac_missing' });
      return res.status(500).json({ error: 'server misconfigured' });
    }
    const raw = await readRawBody(req);
    const signature = (req.get('x-ease-signature') || '').trim();
    if (!signature) {
      appendLog({ ts: new Date().toISOString(), type: 'missing_signature', ip: req.ip });
      return res.status(401).json({ error: 'missing signature' });
    }
    const computed = computeHmacHex(Buffer.from(raw, 'utf8'), WEBHOOK_SECRET);
    // timing safe compare
    const a = Buffer.from(computed, 'hex');
    let b;
    try { b = Buffer.from(signature, 'hex'); } catch { b = Buffer.alloc(a.length); }
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      appendLog({ ts: new Date().toISOString(), type: 'invalid_signature', ip: req.ip });
      return res.status(401).json({ error: 'invalid signature' });
    }

    // parse payload
    const payload = JSON.parse(raw);
    const buyerId = String(payload.buyer_id || payload.user_id || payload.id || '').replace(/\D/g, '');
    const amount = Number(payload.amount || payload.value || 0);
    if (!buyerId || !isFinite(amount) || amount <= 0) {
      appendLog({ ts: new Date().toISOString(), type: 'bad_payload', payload });
      return res.status(400).json({ error: 'bad payload' });
    }

    // update DB
    const db = loadDB();
    if (!db.users[buyerId]) db.users[buyerId] = { total: 0, history: [] };
    db.users[buyerId].total = Number((db.users[buyerId].total + amount).toFixed(2));
    db.users[buyerId].history.push({ ts: new Date().toISOString(), amount, source: 'webhook' });
    db.meta = db.meta || { totalAll: 0 };
    db.meta.totalAll = Number((db.meta.totalAll + amount).toFixed(2));
    saveDB(db);
    appendLog({ ts: new Date().toISOString(), type: 'purchase', buyerId, amount });

    // try to apply role & notify
    try {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (!guild) {
        appendLog({ ts: new Date().toISOString(), type: 'guild_missing', GUILD_ID });
        return res.json({ ok: true, note: 'saved' });
      }
      const member = await guild.members.fetch(buyerId).catch(() => null);
      if (!member) {
        appendLog({ ts: new Date().toISOString(), type: 'member_missing', buyerId });
        return res.json({ ok: true, note: 'saved but user not in guild' });
      }
      let bestRank = null;
      for (const r of RANKS) if (db.users[buyerId].total >= r.amount) bestRank = r;
      if (!bestRank) {
        appendLog({ ts: new Date().toISOString(), type: 'no_rank', buyerId });
        return res.json({ ok: true, note: 'no rank' });
      }
      if (!member.roles.cache.has(bestRank.role)) {
        for (const r of RANKS) {
          if (member.roles.cache.has(r.role)) {
            await member.roles.remove(r.role).catch(()=>{});
            appendLog({ ts: new Date().toISOString(), type: 'role_removed', buyerId, role: r.role });
          }
        }
        await member.roles.add(bestRank.role).catch(err => appendLog({ ts: new Date().toISOString(), type: 'role_add_failed', buyerId, role: bestRank.role, error: String(err) }));
        appendLog({ ts: new Date().toISOString(), type: 'role_added', buyerId, role: bestRank.role });
      }

      const channel = guild.channels.cache.get(CANAL_PROMOCOES) || guild.channels.cache.find(c => c.id === CANAL_PROMOCOES);
      if (channel && channel.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle(`${member.user.username} foi promovido`)
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
          .setDescription(`Total gasto: R$ ${db.users[buyerId].total.toFixed(2)}\nNovo cargo: <@&${bestRank.role}>`)
          .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(err => appendLog({ ts: new Date().toISOString(), type: 'embed_failed', error: String(err) }));
      }

      if (LOG_CHANNEL) {
        const logch = guild.channels.cache.get(LOG_CHANNEL);
        if (logch && logch.isTextBased()) logch.send(`Purchase: ${buyerId} +R$ ${amount}`).catch(()=>{});
      }

    } catch (err) {
      appendLog({ ts: new Date().toISOString(), type: 'discord_apply_error', error: String(err) });
    }

    return res.json({ ok: true });
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), type: 'webhook_top_error', error: String(err) });
    return res.status(500).json({ error: 'internal' });
  }
});

// load commands handlers for local use (slash run-time)
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
const commands = new Collection();
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  commands.set(cmd.data.name, cmd);
}

// Discord client actions (slash)
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
    // Post-process: after /comprar we should apply roles (mirror logic) - attempt now:
    if (interaction.commandName === 'comprar') {
      // small delay to ensure DB saved
      const userId = interaction.user.id;
      const db = loadDB();
      let bestRank = null;
      if (db.users[userId]) {
        for (const r of RANKS) if (db.users[userId].total >= r.amount) bestRank = r;
      }
      if (bestRank) {
        try {
          const guild = client.guilds.cache.get(GUILD_ID);
          if (guild) {
            const member = await guild.members.fetch(userId).catch(()=>null);
            if (member && !member.roles.cache.has(bestRank.role)) {
              for (const r of RANKS) if (member.roles.cache.has(r.role)) await member.roles.remove(r.role).catch(()=>{});
              await member.roles.add(bestRank.role).catch(()=>{});
              appendLog({ ts: new Date().toISOString(), type: 'role_added_manual', userId, role: bestRank.role });
              // notify promotions channel
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

// start express and login client
app.listen(PORT, () => { winLogger.info(`Express listening on ${PORT}`); });
client.login(TOKEN).catch(err => {
  winLogger.error('Discord login failed: ' + String(err));
  process.exit(1);
});