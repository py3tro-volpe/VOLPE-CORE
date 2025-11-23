// src/commands/comprar.js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Adicionar valor de compra (teste/manual)')
    .addNumberOption(opt => opt.setName('valor').setDescription('Valor em reais').setRequired(true)),
  async execute(interaction, { loadDB, saveDB, appendLog, RANKS }) {
    const valor = Number(interaction.options.getNumber('valor'));
    const userId = interaction.user.id;

    if (!valor || isNaN(valor) || valor <= 0) {
      return interaction.reply({ content: 'Valor inválido', ephemeral: true });
    }

    const db = loadDB();
    if (!db.users[userId]) db.users[userId] = { total: 0, history: [] };
    db.users[userId].total = Number((db.users[userId].total + valor).toFixed(2));
    db.users[userId].history = db.users[userId].history || [];
    db.users[userId].history.push({ ts: new Date().toISOString(), amount: valor, source: 'manual' });
    db.meta = db.meta || { totalAll: 0 };
    db.meta.totalAll = Number((db.meta.totalAll + valor).toFixed(2));
    saveDB(db);
    appendLog({ ts: new Date().toISOString(), type: 'manual_add', actor: userId, amount: valor });

    // find best rank
    let bestRank = null;
    for (const r of RANKS) if (db.users[userId].total >= r.amount) bestRank = r;

    if (!bestRank) {
      return interaction.reply({ content: `Valor adicionado. Total agora: R$ ${db.users[userId].total.toFixed(2)} (sem cargo aplicável)`, ephemeral: true });
    }

    // role application will be done in server.js (so slash stays fast)
    return interaction.reply({ content: `Valor adicionado. Total agora: R$ ${db.users[userId].total.toFixed(2)}. Cargo a aplicar: <@&${bestRank.role}>`, ephemeral: true });
  }
};