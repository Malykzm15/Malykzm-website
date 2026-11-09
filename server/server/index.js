const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL
}));

app.use(express.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

app.get("/", (req, res) => {
  res.send("Malykzm payment server is running!");
});

app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, amount, reference } = req.body;

    if (!email || !Number.isInteger(amount) || amount < 100 || !reference) {
      return res.status(400).json({ error: "Invalid payment details." });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Payment server is not configured." });
    }

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: amount * 100,
          reference,
          currency: "NGN"
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(400).json({ error: "Could not initialize payment." });
    }

    res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (error) {
    res.status(500).json({ error: "Payment initialization failed." });
  }
});

app.get("/api/paystack/verify/:reference", async (req, res) => {
  try {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(req.params.reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(400).json({ error: "Payment verification failed." });
    }

    res.json({
      status: data.data.status,
      amount: data.data.amount,
      currency: data.data.currency,
      reference: data.data.reference
    });
  } catch (error) {
    res.status(500).json({ error: "Could not verify payment." });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Malykzm payment server running on port ${PORT}`);
});
