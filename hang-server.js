#!/usr/bin/env node
/*
 * Claude-Rex — "black hole" test server
 * ------------------------------------------------------------------
 * Accepts any request and NEVER responds, so the Claude Code CLI (which
 * the extension drives) sits in its "working" state indefinitely. That
 * keeps the spinner row mounted forever — i.e. infinite dino playtime —
 * without sending anything to the real API or spending a single token.
 *
 * Usage:
 *   node hang-server.js            # listens on http://localhost:8787
 *   PORT=9000 node hang-server.js  # custom port
 *
 * Then launch your editor with the API pointed here (see README), send
 * any prompt, and play. Stop the spinner with the panel's interrupt
 * control (Esc), and stop this server with Ctrl+C.
 */
"use strict";

const http = require("http");
const PORT = parseInt(process.env.PORT || "8787", 10);

const server = http.createServer((req, res) => {
  // Drain the request body so the client thinks it was received...
  req.resume();
  const when = new Date().toISOString().slice(11, 19);
  console.log(`${when}  ${req.method} ${req.url}  -> holding open (no response)`);
  // ...then never call res.end(). The socket stays open; the CLI waits.
  // Keep the connection alive long enough to not be killed by idle logic.
  req.socket.setKeepAlive(true);
});

server.on("connection", (s) => s.setTimeout(0)); // disable socket timeouts

server.listen(PORT, () => {
  console.log(`🕳️  black hole listening on http://localhost:${PORT}`);
  console.log("    Point ANTHROPIC_BASE_URL here, send a prompt, and play.");
  console.log("    Ctrl+C to stop.");
});
