// commands/comprar.js
const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Registra uma compra e aplica cargos automaticamente')
    .addNumberOption(option =>
      option.setName('valor')
        .setDescription('Valor gasto pelo usuário')
        .setRequired(true)
    ),

  async execute(interaction, { loadDB, saveDB, appendLog, RANKS }) {
    const valor = interaction.options.getNumber('valor');
    const userId = interaction.user.id;

    if (!valor || valor <= 0) {
      return interaction.reply({ content: 'Insira um valor válido.', ephemeral: true });
    }

    // Carregar DB
    const db = loadDB();
    if (!db.users[userId]) db.users[userId] = { total: 0, history: [] };

    db.users[userId].total += valor;
    db.users[userId].history.push({ ts: new Date().toISOString(), amount: valor, source: 'manual' });
    saveDB(db);

    appendLog({ ts: new Date().toISOString(), type: 'manual_purchase', userId, amount: valor });

    await interaction.reply({ content: `Compra de R$ ${valor.toFixed(2)} registrada!`, ephemeral: true });
  }
};