import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import twilio from "twilio";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Clients
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "SMILE AI" });
});

// WhatsApp webhook
app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming WhatsApp:", from, body);

  if (!from || !body) {
    return res.status(200).send("OK");
  }

  let reply = "Ciao 💛 Sono SMILE AI. Raccontami come ti senti oggi.";

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are SMILE AI, a kind and supportive emotional assistant. You are not a therapist. Respond with empathy, short sentences, and one gentle question.",
        },
        { role: "user", content: body },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    reply =
      completion.choices[0]?.message?.content ||
      "Sono qui con te. Vuoi raccontarmi di più?";
  } catch (err) {
    console.error("OpenAI error:", err);
    reply =
      "Sono qui con te. In questo momento puoi prenderti un respiro lento e profondo.";
  }

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply,
    });
  } catch (err) {
    console.error("Twilio error:", err);
  }

  res.status(200).send("OK");
});

// Start server
app.listen(PORT, () => {
  console.log(`SMILE AI backend running on port ${PORT}`);
});
