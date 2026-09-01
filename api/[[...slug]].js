// Vercel catch-all serverless function — handles ALL HTTP paths
// Routes every request through the Express app in lib/server.js
const app = require('../lib/server.js');
module.exports = app;
