require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const { OpenAI } = require("openai");
const { Pool } = require("pg");

const app = express();

// Twilio manda webhook in x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---- Healthcheck
app.get("/", (_req, res) => {
  res.status(200).send("SMILE AI backend is running ✅");
});

// ---- DB init (idempotente)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(channel, external_user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ---- Helper: get/create user
async function getOrCreateUser(channel, externalUserId) {
  const existing = await pool.query(
    `SELECT id FROM users WHERE channel=$1 AND external_user_id=$2`,
    [channel, externalUserId]
  );
  if (existing.rowCount) return existing.rows[0].id;

  const created = await pool.query(
    `INSERT INTO users (channel, external_user_id) VALUES ($1,$2) RETURNING id`,
    [channel, externalUserId]
  );
  return created.rows[0].id;
}

// ---- Helper: save message
async function saveMessage(userId, role, content) {
  await pool.query(
    `INSERT INTO messages (user_id, role, content) VALUES ($1,$2,$3)`,
    [userId, role, content]
  );
}

// ---- Helper: load last N messages
async function loadContext(userId, limit = 12) {
  const r = await pool.query(
    `SELECT role, content
     FROM messages
     WHERE user_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  // reverse to chronological
  return r.rows.reverse().map(x => ({ role: x.role, content: x.content }));
}

// ---- Twilio signature validation (consigliata)
function validateTwilio(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // se non settato, non blocco (MVP)

  const signature = req.headers["x-twilio-signature"];
  const url = `${process.env.PUBLIC_BASE_URL}${req.originalUrl}`;

  return twilio.validateRequest(
    authToken,
    signature,
    url,
    req.body
  );
}

// ---- WhatsApp webhook
app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  try {
    // opzionale ma top
    if (!validateTwilio(req)) {
      return res.status(403).send("Invalid Twilio signature");
    }

    const from = req.body.From;      // es: "whatsapp:+4176..."
    const body = (req.body.Body || "").trim();

    const twiml = new twilio.twiml.MessagingResponse();

    if (!body) {
      twiml.message("Scrivimi un messaggio 🙂");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // 1) user
    const userId = await getOrCreateUser("whatsapp", from);
    await saveMessage(userId, "user", body);

    // 2) contesto + system prompt MVP
    const context = await loadContext(userId, 10);

    const systemPrompt =
      "Sei SMILE AI, un assistente di supporto emotivo. " +
      "Sii empatico, non giudicante, fai domande brevi e utili. " +
      "Se l’utente sembra a rischio di autolesionismo o pericolo immediato, " +
      "invita a contattare subito i servizi di emergenza locali.";

    const messages = [
      { role: "system", content: systemPrompt },
      ...context
    ];

    // 3) risposta AI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7
    });

    const reply = completion.choices?.[0]?.message?.content?.trim()
      || "Sono qui con te. Raccontami un po’ di più 🙂";

    // 4) salva e rispondi
    await saveMessage(userId, "assistant", reply);

    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    // Twilio vuole comunque un 200 spesso, ma qui mando 200 con fallback
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Ho avuto un piccolo problema tecnico. Riprova tra qualche secondo 🙏");
    res.type("text/xml").send(twiml.toString());
  }
});

// ---- Status callback (opzionale)
app.post("/webhooks/twilio/status", (req, res) => {
  res.status(200).send("ok");
});

const port = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(port, () => console.log(`SMILE AI listening on ${port}`));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
