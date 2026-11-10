const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

app.get("/", (req, res) => {
  res.send("Malykzm payment server is running!");
});

function requireConfiguration(res) {
  if (!supabase || !PAYSTACK_SECRET_KEY) {
    res.status(500).json({ error: "Payment server is not configured." });
    return false;
  }
  return true;
}

async function requireUser(req, res, next) {
  if (!supabase) {
    return res.status(500).json({ error: "Wallet server is not configured." });
  }

  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({ error: "Please log in to continue." });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({ error: "Your login session is invalid or expired." });
  }

  req.user = data.user;
  next();
}

app.post("/api/wallet/fund", requireUser, async (req, res) => {
  try {
    if (!requireConfiguration(res)) return;

    const amount = req.body.amount;
    if (!Number.isSafeInteger(amount) || amount < 500 || amount > 10000000) {
      return res.status(400).json({
        error: "Enter an amount between ₦500 and ₦10,000,000."
      });
    }

    const email = req.user.email;
    if (!email) {
      return res.status(400).json({ error: "Your account needs a valid email address." });
    }

    const reference = "MALYKZM_" + crypto.randomUUID();
    const amountKobo = amount * 100;

    const { error: walletError } = await supabase
      .from("wallets")
      .upsert({ user_id: req.user.id }, { onConflict: "user_id", ignoreDuplicates: true });

    if (walletError) {
      return res.status(500).json({ error: "Could not prepare your wallet." });
    }

    const { error: transactionError } = await supabase
      .from("wallet_transactions")
      .insert({
        user_id: req.user.id,
        reference,
        type: "deposit",
        amount_kobo: amountKobo,
        status: "pending"
      });

    if (transactionError) {
      return res.status(500).json({ error: "Could not create your deposit record." });
    }

    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: amountKobo,
          reference,
          currency: "NGN",
          metadata: {
            user_id: req.user.id,
            purpose: "wallet_funding"
          }
        })
      }
    );

    const paystackData = await paystackResponse.json();

    if (!paystackResponse.ok || !paystackData.status || !paystackData.data?.authorization_url) {
      await supabase
        .from("wallet_transactions")
        .update({ status: "failed" })
        .eq("reference", reference);

      return res.status(400).json({ error: "Paystack could not start this payment. Please try again." });
    }

    return res.json({
      authorization_url: paystackData.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error("Wallet funding initialization error:", error);
    return res.status(500).json({ error: "Could not start wallet funding." });
  }
});

app.get("/api/wallet/verify/:reference", requireUser, async (req, res) => {
  try {
    if (!requireConfiguration(res)) return;

    const reference = req.params.reference;
    const { data: transaction, error: lookupError } = await supabase
      .from("wallet_transactions")
      .select("id,user_id,reference,type,amount_kobo,status")
      .eq("reference", reference)
      .eq("user_id", req.user.id)
      .eq("type", "deposit")
      .maybeSingle();

    if (lookupError || !transaction) {
      return res.status(404).json({ error: "Deposit record not found." });
    }

    if (transaction.status === "successful") {
      return res.json({ status: "success", already_credited: true });
    }

    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
      {
        headers: { Authorization: "Bearer " + PAYSTACK_SECRET_KEY }
      }
    );
    const paystackData = await paystackResponse.json();

    if (
      !paystackResponse.ok ||
      !paystackData.status ||
      paystackData.data?.status !== "success" ||
      paystackData.data?.currency !== "NGN" ||
      paystackData.data?.amount !== transaction.amount_kobo ||
      paystackData.data?.reference !== transaction.reference
    ) {
      return res.status(400).json({ error: "Payment is not confirmed. Your wallet has not been credited." });
    }

    const { data: creditResult, error: creditError } = await supabase.rpc(
      "credit_wallet_deposit",
      { p_reference: reference }
    );

    if (creditError) {
      console.error("Wallet credit error:", creditError);
      return res.status(500).json({ error: "Payment was verified, but wallet credit needs attention. Contact support with your reference." });
    }

    return res.json({
      status: "success",
      reference,
      credit: creditResult
    });
  } catch (error) {
    console.error("Wallet payment verification error:", error);
    return res.status(500).json({ error: "Could not verify this payment." });
  }
});

app.get("/api/wallet", requireUser, async (req, res) => {
  try {
    if (!requireConfiguration(res)) return;

    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("balance_kobo,created_at,updated_at")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (walletError) {
      return res.status(500).json({ error: "Could not load your wallet." });
    }

    const { data: transactions, error: transactionsError } = await supabase
      .from("wallet_transactions")
      .select("reference,type,amount_kobo,status,created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (transactionsError) {
      return res.status(500).json({ error: "Could not load your transaction history." });
    }

    return res.json({
      balance_kobo: wallet?.balance_kobo ?? 0,
      transactions: transactions || []
    });
  } catch (error) {
    console.error("Wallet fetch error:", error);
    return res.status(500).json({ error: "Could not load your wallet." });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Malykzm payment server running on port " + PORT);
});
