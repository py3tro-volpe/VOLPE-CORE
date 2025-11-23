// src/db-system.js
const fs = require('fs');
const path = require('path');

const DB_DIR = __dirname;
const dbPath = path.join(DB_DIR, 'db.json');
const logsPath = path.join(DB_DIR, 'logs.json');
const backupDir = path.join(DB_DIR, 'backups');

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ users: {}, meta: { totalAll: 0 } }, null, 2));
if (!fs.existsSync(logsPath)) fs.writeFileSync(logsPath, JSON.stringify([], null, 2));

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function loadDB() { return readJSON(dbPath); }
function saveDB(db) { writeJSON(dbPath, db); }

function appendLog(entry) {
  const logs = readJSON(logsPath);
  logs.push(entry);
  if (logs.length > 20000) logs.splice(0, logs.length - 20000);
  writeJSON(logsPath, logs);
  return entry;
}

function readLogs(limit = 200) {
  const logs = readJSON(logsPath);
  return logs.slice(-limit).reverse();
}

function createBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `db-backup-${ts}.json`);
  fs.copyFileSync(dbPath, dest);
  return dest;
}

module.exports = { loadDB, saveDB, appendLog, readLogs, createBackup };