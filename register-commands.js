require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('Configure TOKEN, CLIENT_ID e GUILD_ID no .env antes de registrar comandos.');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands'); // agora aponta para a raiz
const files = fs.existsSync(commandsPath) ? fs.readdirSync(commandsPath).filter(f => f.endsWith('.js')) : [];

for (const file of files) {
  const cmd = require(path.join(commandsPath, file));
  commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`Registrando ${commands.length} comandos no servidor ${guildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log('Comandos registrados com sucesso (server-only).');
  } catch (err) {
    console.error('Falha ao registrar comandos:', err);
  }
})();
