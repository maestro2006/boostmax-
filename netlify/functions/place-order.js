const { createClient } = require("@supabase/supabase-js");

const SERVICES = {
  instagram: {
    abonnes: { rate:1500, per:1000,  min:10,  max:1000000,    serviceId:"26421", provider:"shaker" },
    like:    { rate:500,  per:1000,  min:100, max:10000000,   serviceId:"26415", provider:"shaker" },
    vue:     { rate:500,  per:10000, min:100, max:2000000000, serviceId:"26413", provider:"shaker" },
  },
  facebook: {
    abonnes: { rate:1500, per:1000, min:500, max:1000000, serviceId:"26424", provider:"shaker" },
    like:    { rate:500,  per:1000, min:10,  max:1000000, serviceId:"26425", provider:"shaker" },
    membres: { rate:1000, per:1000, min:10,  max:1000000, serviceId:"23884", provider:"shaker" },
  },
  tiktok: {
    abonnes:    { rate:1500, per:1000,  min:10,  max:100000,     serviceId:"18847", provider:"smm"    },
    like:       { rate:500,  per:1000,  min:50,  max:20000,      serviceId:"20979", provider:"shaker" },
    vue:        { rate:500,  per:10000, min:100, max:2000000000, serviceId:"26406", provider:"shaker" },
    partage:    { rate:500,  per:10000, min:100, max:2000000000, serviceId:"18622", provider:"shaker" },
    sauvegarde: { rate:500,  per:10000, min:100, max:2000000000, serviceId:"22289", provider:"shaker" },
  },
  youtube: {
    abonnes: { rate:2000, per:1000, min:50,  max:20000,   serviceId:"17989", provider:"smm" },
    like:    { rate:500,  per:1000, min:100, max:100000,  serviceId:"18466", provider:"smm" },
    vue:     { rate:500,  per:1000, min:100, max:1000000, serviceId:"17988", provider:"smm" },
  },
  telegram: {
    membres:    { rate:2500, per:1000, min:100, max:100000, serviceId:"26314", provider:"shaker" },
    membres_nd: { rate:4000, per:1000, min:500, max:100000, serviceId:"21416", provider:"shaker" },
  },
  spotify: {
    streams: { rate:500,  per:1000, min:500, max:100000000, serviceId:"19369", provider:"shaker" },
    abonnes: { rate:1000, per:1000, min:100, max:1000000,   serviceId:"23979", provider:"shaker" },
  },
  applemusic: {
    streams: { rate:2000, per:1000, min:1000, max:1000000, serviceId:"6474", provider:"shaker" },
    abonnes: { rate:5000, per:1000, min:500,  max:100000,  serviceId:"6470", provider:"shaker" },
  },
  whatsapp: {
    membres:    { rate:2000,  per:1000, min:10, max:1000,  serviceId:"24058", provider:"shaker" },
    membres_nd: { rate:3500,  per:1000, min:10, max:1000,  serviceId:"24060", provider:"shaker" },
    reaction:   { rate:500,   per:1000, min:10, max:50000, serviceId:"18839", provider:"shaker" },
    bot_6mois:  { rate:12000, per:1,    min:1,  max:1,     serviceId:"17789", provider:"shaker" },
    bot_1an:    { rate:18000, per:1,    min:1,  max:1,     serviceId:"7692",  provider:"shaker" },
    bot_vie:    { rate:42000, per:1,    min:1,  max:1,     serviceId:"7772",  provider:"shaker" },
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  let body;
  try { body = JSON.parse(event.body); } catch { return errorResp(400, "Requête invalide."); }
  const { platform, serviceKey, quantity, link } = body;

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return errorResp(401, "Non authentifié.");
  const token = authHeader.replace("Bearer ", "");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return errorResp(401, "Session invalide.");
  const userId = userData.user.id;

  const svc = SERVICES[platform]?.[serviceKey];
  if (!svc) return errorResp(400, "Service invalide.");
  if (!link) return errorResp(400, "Lien ou nom d'utilisateur manquant.");
  const qty = Number(quantity);
  if (!qty || qty < svc.min || qty > svc.max)
    return errorResp(400, `Quantité invalide (entre ${svc.min} et ${svc.max}).`);

  const price = Math.round(qty * (svc.rate / svc.per));

  let newBalance;
  try {
    const { data, error } = await supabase.rpc("deduct_balance", { p_user_id: userId, p_amount: price });
    if (error) throw error;
    newBalance = data;
  } catch (err) {
    if (String(err.message || err).includes("INSUFFICIENT_BALANCE")) return errorResp(400, "Solde insuffisant.");
    return errorResp(500, "Erreur lors du débit du solde.");
  }

  const { data: orderRow, error: orderErr } = await supabase.from("orders")
    .insert({ user_id: userId, platform, tier_name: serviceKey, service_id: svc.serviceId, link, price, quantity: qty, status: "processing" })
    .select().single();
  if (orderErr || !orderRow) { await refund(supabase, userId, price, null); return errorResp(500, "Erreur création commande — solde remboursé."); }
  await supabase.from("transactions").insert({ user_id: userId, type: "order", amount: -price, status: "completed", payment_ref: orderRow.id });

  const apiUrl = svc.provider === "shaker" ? process.env.SMM2_API_URL : process.env.SMM_API_URL;
  const apiKey = svc.provider === "shaker" ? process.env.SMM2_API_KEY : process.env.SMM_API_KEY;
  if (!apiUrl || !apiKey) { await refund(supabase, userId, price, orderRow.id); return errorResp(500, "Fournisseur non configuré — solde remboursé."); }

  try {
    const params = new URLSearchParams({ key: apiKey, action: "add", service: svc.serviceId, link, quantity: String(qty) });
    const response = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
    const data = await response.json();
    if (data?.order) {
      await supabase.from("orders").update({ status: "completed", smm_order_id: String(data.order) }).eq("id", orderRow.id);
      return { statusCode: 200, body: JSON.stringify({ success: true, orderId: data.order, price, balance: newBalance }) };
    }
    await refund(supabase, userId, price, orderRow.id);
    return errorResp(200, data?.error || "Le fournisseur a refusé la commande — solde remboursé.");
  } catch { await refund(supabase, userId, price, orderRow.id); return errorResp(500, "Erreur fournisseur — solde remboursé."); }
};

async function refund(supabase, userId, price, orderId) {
  await supabase.rpc("credit_balance", { p_user_id: userId, p_amount: price });
  if (orderId) {
    await supabase.from("orders").update({ status: "failed" }).eq("id", orderId);
    await supabase.from("transactions").insert({ user_id: userId, type: "refund", amount: price, status: "completed", payment_ref: orderId });
  }
}
function errorResp(code, error) { return { statusCode: code, body: JSON.stringify({ success: false, error }) }; }
