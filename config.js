// language: JavaScript, file: config.js
export default {
  botName: 'BAZZ WA MD BOT',
  owner: '447869794924', // apna number yahan
  ownerName: 'BAZZ',
  prefix: '.',
  menuImage: './assets/menu.jpg',
  sessionDir: './sessions',
  timezone: 'Asia/Karachi',
  geminiModel: 'gemini-2.0-flash-lite',

  geminiKey: 'YOUR_GEMINI_API_KEY_HERE',
  paksimApi: 'https://sim-db.elevatex.workers.dev/pak-data',

  nexoracle: {
    base: 'https://api.nexoracle.com/details',
    paid: 'https://api.nexoracle.com/details/pak-sim-database',
    free: 'https://api.nexoracle.com/details/pak-sim-database-free',
    paidKey: '49d32e2308c704f3fa',
    freeKey: 'free_key@maher_apis'
  }
};
