/**
 * Main Character Energy - Notification Backend
 *
 * Deployed as a Cloudflare Worker. Receives schedule/state from the app,
 * stores in Workers KV, and fires Web Push notifications via a cron trigger.
 *
 * SETUP:
 * 1. Create a KV namespace called USERS and bind it to this Worker.
 * 2. Add a Cron Trigger: "* * * * *" (every minute).
 * 3. Replace VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY below with your generated keys.
 *    Generate with: npx web-push generate-vapid-keys
 * 4. Set VAPID_SUBJECT to a mailto: link with your contact email.
 * 5. Deploy.
 *
 * The app POSTs to /subscribe, /schedule, /state, /unsubscribe with JSON bodies.
 * CORS is permissive (any origin) since this is personal use.
 */

const VAPID_PUBLIC_KEY = "REPLACE_WITH_VAPID_PUBLIC_KEY";
const VAPID_PRIVATE_KEY = "REPLACE_WITH_VAPID_PRIVATE_KEY";
const VAPID_SUBJECT = "mailto:REPLACE_WITH_YOUR_EMAIL@example.com";

// ===== Routing =====

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (path === "/subscribe" && request.method === "POST") return await subscribe(request, env);
      if (path === "/schedule" && request.method === "POST") return await updateSchedule(request, env);
      if (path === "/state" && request.method === "POST") return await updateState(request, env);
      if (path === "/unsubscribe" && request.method === "POST") return await unsubscribe(request, env);
      if (path === "/test" && request.method === "POST") return await testNotification(request, env);
      if (path === "/debug" && request.method === "GET") return await debugDump(request, env);
      if (path === "/vapid-public-key") return jsonResponse({ key: VAPID_PUBLIC_KEY });
      if (path === "/" || path === "") return new Response("Main Character Energy notification backend OK", { headers: corsHeaders() });
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    } catch (err) {
      return jsonResponse({ error: err.message, stack: err.stack }, 500);
    }
  },

  // Cron trigger: fires every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processCron(env));
  },
};

// ===== Endpoint handlers =====

async function subscribe(request, env) {
  const body = await request.json();
  const { subscription, wakeUpTime, sleepShift, timezone, prefs } = body;
  if (!subscription || !subscription.endpoint) {
    return jsonResponse({ error: "Missing subscription" }, 400);
  }
  const key = endpointToKey(subscription.endpoint);
  // Preserve existing state (lastFired dedup, check-in/tech-off flags) if this
  // endpoint is already known — re-subscribing on app refresh must not wipe the
  // record and cause the cron to re-fire today's already-sent notifications.
  const prior = await env.USERS.get(key, { type: "json" });
  const record = {
    subscription,
    wakeUpTime: wakeUpTime || (prior && prior.wakeUpTime) || "10:00",
    sleepShift: sleepShift !== undefined ? sleepShift : (prior ? prior.sleepShift : 0),
    timezone: timezone || (prior && prior.timezone) || "Europe/London",
    prefs: prefs || (prior && prior.prefs) || defaultPrefs(),
    state: (prior && prior.state) ? prior.state : { lastFired: {} },
    updatedAt: new Date().toISOString(),
  };
  await env.USERS.put(key, JSON.stringify(record));
  return jsonResponse({ ok: true, key });
}

async function updateSchedule(request, env) {
  const body = await request.json();
  const { endpoint, wakeUpTime, sleepShift, timezone, prefs } = body;
  if (!endpoint) return jsonResponse({ error: "Missing endpoint" }, 400);
  const key = endpointToKey(endpoint);
  const existing = await env.USERS.get(key, { type: "json" });
  if (!existing) return jsonResponse({ error: "Subscription not found" }, 404);
  if (wakeUpTime !== undefined) existing.wakeUpTime = wakeUpTime;
  if (sleepShift !== undefined) existing.sleepShift = sleepShift;
  if (timezone !== undefined) existing.timezone = timezone;
  if (prefs !== undefined) existing.prefs = prefs;
  existing.updatedAt = new Date().toISOString();
  await env.USERS.put(key, JSON.stringify(existing));
  return jsonResponse({ ok: true });
}

async function updateState(request, env) {
  // App reports check-in / tech-off state changes so the Worker can skip those notifications today.
  const body = await request.json();
  const { endpoint, checkedInDate, techOffDate } = body;
  if (!endpoint) return jsonResponse({ error: "Missing endpoint" }, 400);
  const key = endpointToKey(endpoint);
  const existing = await env.USERS.get(key, { type: "json" });
  if (!existing) return jsonResponse({ error: "Subscription not found" }, 404);
  if (!existing.state) existing.state = { lastFired: {} };
  if (checkedInDate !== undefined) existing.state.checkedInDate = checkedInDate;
  if (techOffDate !== undefined) existing.state.techOffDate = techOffDate;
  existing.updatedAt = new Date().toISOString();
  await env.USERS.put(key, JSON.stringify(existing));
  return jsonResponse({ ok: true });
}

async function unsubscribe(request, env) {
  const body = await request.json();
  const { endpoint } = body;
  if (!endpoint) return jsonResponse({ error: "Missing endpoint" }, 400);
  await env.USERS.delete(endpointToKey(endpoint));
  return jsonResponse({ ok: true });
}

async function testNotification(request, env) {
  const body = await request.json();
  const { endpoint } = body;
  if (!endpoint) return jsonResponse({ error: "Missing endpoint" }, 400);
  const key = endpointToKey(endpoint);
  const record = await env.USERS.get(key, { type: "json" });
  if (!record) return jsonResponse({ error: "Subscription not found" }, 404);
  await sendPush(record.subscription, {
    title: "🔔 Backend Test",
    body: "Backend notifications working ✅",
    tag: "test",
  });
  return jsonResponse({ ok: true });
}

async function debugDump(request, env) {
  const list = await env.USERS.list();
  const out = [];
  for (const item of list.keys) {
    const v = await env.USERS.get(item.name, { type: "json" });
    out.push({ key: item.name, value: v });
  }
  return jsonResponse(out);
}

// ===== Cron logic =====

async function processCron(env) {
  const list = await env.USERS.list();
  for (const item of list.keys) {
    const record = await env.USERS.get(item.name, { type: "json" });
    if (!record) continue;
    try {
      await processUser(env, item.name, record);
    } catch (err) {
      console.error("Failed for user", item.name, err);
    }
  }
}

async function processUser(env, key, record) {
  const { wakeUpTime, sleepShift, timezone, prefs, state } = record;
  if (!prefs) return;

  // Get current local time + date in user's timezone
  const { hour, minute, dayOfWeek, dateStr, effectiveDateStr } = nowInTimezone(timezone);
  const nowMinutes = hour * 60 + minute;

  // Compute target times (all in minutes since local midnight)
  const [wakeHour, wakeMinute] = (wakeUpTime || "10:00").split(":").map(Number);
  const wakeMin = wakeHour * 60 + wakeMinute;

  // Chill = wake + 15h, minus sleep shift
  const chillRaw = wakeMin + 15 * 60 - (sleepShift || 0);
  const chillMin = ((chillRaw % 1440) + 1440) % 1440;
  const chillWarningMin = ((chillMin - 60 + 1440) % 1440);
  const chillLastCallMin = (chillMin + 15) % 1440;

  // Fasting: 12.25h after wake, minus sleep shift
  const fastStartRaw = wakeMin + Math.round(12.25 * 60) - (sleepShift || 0);
  const fastStartMin = ((fastStartRaw % 1440) + 1440) % 1440;
  const fastWarningMin = ((fastStartMin - 30 + 1440) % 1440);

  // effectiveDateStr is "today" with 4am cutoff applied (matches app)
  const today = effectiveDateStr;
  const effDate = new Date(effectiveDateStr + "T12:00:00Z"); // midday avoids any DST edge
  const effDow = effDate.getUTCDay(); // 0=Sun
  const isFastingDay = (effDow === 0 || effDow === 2 || effDow === 4);

  if (!state) record.state = { lastFired: {} };
  if (!record.state.lastFired) record.state.lastFired = {};

  // Helper: should I fire this notification right now?
  // Cron runs every minute, so we only need a tiny grace window to absorb a
  // single missed/delayed tick. No multi-hour catch-up.
  function shouldFire(notifId, targetMin) {
    if (record.state.lastFired[notifId] === today) return false;
    const minutesPast = nowMinutes - targetMin;
    return minutesPast >= 0 && minutesPast <= 2;
  }

  function markFired(notifId) {
    record.state.lastFired[notifId] = today;
  }

  const toSend = [];

  // 10am check-in (skip if already checked in today)
  if (prefs.notifyCheckIn && record.state.checkedInDate !== today) {
    if (shouldFire("checkin", 10 * 60)) {
      toSend.push({ id: "checkin", payload: { title: "⏰ Time to Check In!", body: "Set your wake-up time and start your day strong! 💪", tag: "checkin" } });
    }
  }

  // Chill warning
  if (prefs.notifyChillWarning && shouldFire("chillwarn", chillWarningMin)) {
    toSend.push({ id: "chillwarn", payload: { title: "⏰ Chill Time in 1 Hour", body: "Start winding down soon. Low-stimulation time approaching! 🌙", tag: "chill-warning" } });
  }

  // Chill alert
  if (prefs.notifyChill && shouldFire("chill", chillMin)) {
    toSend.push({ id: "chill", payload: { title: "🌙 Chill Time Now!", body: "Press Tech Off to log your wind-down time! 📵", tag: "chill", requireInteraction: true, actions: [{ action: "techoff", title: "📵 Tech Off" }, { action: "dismiss", title: "Dismiss" }] } });
  }

  // Chill last call (only if tech-off not pressed today)
  if (prefs.notifyChill && record.state.techOffDate !== today && shouldFire("chill-lastcall", chillLastCallMin)) {
    toSend.push({ id: "chill-lastcall", payload: { title: "⏰ Last Call for Tech Off!", body: "5 minutes left to log your chill time! Don't miss it! 📵", tag: "chill-lastcall", requireInteraction: true } });
  }

  // Fasting warning (fasting days only)
  if (prefs.notifyFasting && isFastingDay && shouldFire("fasting", fastWarningMin)) {
    toSend.push({ id: "fasting", payload: { title: "⏰ Fasting Window in 30 Minutes", body: "Last chance for nutrition! Fast starts soon. 🥗", tag: "fasting-warning" } });
  }

  // End-of-week summary (Sunday 21:00)
  if (prefs.notifyWeekEnd && effDow === 0 && shouldFire("weeksum", 21 * 60)) {
    toSend.push({ id: "weeksum", payload: { title: "📊 Sunday Summary", body: "Open the app to review this week.", tag: "weeksum" } });
  }

  if (toSend.length === 0) return;

  for (const notif of toSend) {
    try {
      await sendPush(record.subscription, notif.payload);
      markFired(notif.id);
    } catch (err) {
      console.error("Push failed for", key, notif.id, err.message);
      // If the subscription is gone (410), delete it
      if (err.statusCode === 410 || err.statusCode === 404) {
        await env.USERS.delete(key);
        return;
      }
    }
  }

  // Persist the updated lastFired state
  record.updatedAt = new Date().toISOString();
  await env.USERS.put(key, JSON.stringify(record));
}

// ===== Timezone helpers =====

function nowInTimezone(tz) {
  const now = new Date();
  // Use Intl to get parts in user's timezone
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const hour = parseInt(parts.hour, 10) % 24; // handle "24" → 0 quirk
  const minute = parseInt(parts.minute, 10);
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // Apply 4am cutoff
  let effDate = dateStr;
  if (hour < 4) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() - 1);
    effDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return { hour, minute, dayOfWeek, dateStr, effectiveDateStr: effDate };
}

// ===== Web Push =====

async function sendPush(subscription, payload) {
  // Web Push from a Cloudflare Worker without external libraries.
  // Builds a JWT signed with the VAPID private key, encrypts the payload,
  // and POSTs to the subscription's endpoint.
  const body = JSON.stringify(payload);
  const auth = await buildVapidAuth(subscription.endpoint);

  // Encrypt payload using subscription's keys (ECDH + HKDF + AES-GCM, per RFC 8291)
  const encrypted = await encryptPayload(body, subscription.keys);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${auth.jwt}, k=${VAPID_PUBLIC_KEY}`,
      "Crypto-Key": `p256ecdsa=${VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
    },
    body: encrypted,
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Push failed: ${res.status} ${text}`);
    err.statusCode = res.status;
    throw err;
  }
}

async function buildVapidAuth(endpoint) {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h
    sub: VAPID_SUBJECT,
  };
  const enc = (obj) => base64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const unsignedToken = `${enc(header)}.${enc(payload)}`;

  const privateKeyJwk = vapidPrivateKeyToJwk(VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY);
  const privateKey = await crypto.subtle.importKey(
    "jwk", privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );
  const jwt = `${unsignedToken}.${base64urlEncode(new Uint8Array(sig))}`;
  return { jwt };
}

function vapidPrivateKeyToJwk(privKeyB64, pubKeyB64) {
  // VAPID keys: public is uncompressed P-256 point (65 bytes, starts with 0x04),
  // private is the d value (32 bytes). Both base64url-encoded.
  const pubBytes = base64urlDecode(pubKeyB64);
  if (pubBytes.length !== 65) throw new Error("Public VAPID key must be 65 bytes (uncompressed P-256)");
  const x = pubBytes.slice(1, 33);
  const y = pubBytes.slice(33, 65);
  const d = base64urlDecode(privKeyB64);
  return {
    kty: "EC", crv: "P-256",
    x: base64urlEncode(x),
    y: base64urlEncode(y),
    d: base64urlEncode(d),
    ext: true,
  };
}

// ===== Payload encryption (aes128gcm, RFC 8291) =====

async function encryptPayload(plaintext, subKeys) {
  // subKeys.p256dh = recipient's public key (base64url, uncompressed)
  // subKeys.auth = 16-byte auth secret (base64url)
  const recipientPubBytes = base64urlDecode(subKeys.p256dh);
  const authSecret = base64urlDecode(subKeys.auth);

  // Generate ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, ["deriveBits"]
  );

  // Import recipient public key
  const recipientPub = await crypto.subtle.importKey(
    "raw", recipientPubBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPub },
    ephemeral.privateKey,
    256
  ));

  // Export ephemeral public key (uncompressed, 65 bytes)
  const ephemeralPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  // Random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF: derive IKM
  // ikm = HKDF(authSecret, ECDH, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\0"),
    recipientPubBytes,
    ephemeralPubRaw
  );
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  // Then derive content encryption key and nonce
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  // Pad plaintext: append 0x02 then zeros (single record, last record marker)
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const padded = new Uint8Array(plaintextBytes.length + 1);
  padded.set(plaintextBytes, 0);
  padded[plaintextBytes.length] = 0x02;

  // AES-GCM encrypt
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    padded
  ));

  // Build aes128gcm body: salt(16) || rs(4 BE = 4096) || idlen(1) || keyid(idlen) || ciphertext
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
  const idlen = new Uint8Array([ephemeralPubRaw.length]);
  return concat(salt, rs, idlen, ephemeralPubRaw, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, ikm));
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const t = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, concat(info, new Uint8Array([0x01]))));
  return t.slice(0, length);
}

// ===== Utilities =====

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function base64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function endpointToKey(endpoint) {
  // Use a stable hash-like key from the endpoint
  return "user:" + base64urlEncode(new TextEncoder().encode(endpoint)).slice(0, 64);
}

function defaultPrefs() {
  return {
    notifyCheckIn: true,
    notifyChillWarning: true,
    notifyChill: true,
    notifyFasting: true,
    notifyWeekEnd: true,
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
