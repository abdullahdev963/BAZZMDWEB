// language: JavaScript, file: database.js
import fs from 'fs';

const DB_FILE = './database.json';
export let db = {};

if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { db = {}; }
}

export function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('db save err:', e.message); }
}
