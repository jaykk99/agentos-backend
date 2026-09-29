// Handles /api path (no slug)
const app = require('../lib/app.js');
module.exports = app;

// Local dev: `npm start` runs `node api/index.js` — without this guard the
// process would just exit (the listen block in lib/app.js only fires when
// lib/app.js itself is the entry point). Vercel requires this file instead,
// so require.main !== module there and nothing listens.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`AgentOS Backend listening on port ${PORT}`);
  });
}
