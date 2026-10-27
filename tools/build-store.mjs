// store/generate.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// store/common.js
var DEFAULT_NAME = "LiveShop";
var DEFAULT_CATS = ["Clothes", "Stationery", "Household", "Shoes", "Wearables", "Other"];
function restBase(cfg) {
  const e = cfg.emulator;
  const root = e ? `http://${e.host || "127.0.0.1"}:${e.firestorePort || 8080}/v1` : "https://firestore.googleapis.com/v1";
  return { root, docs: `projects/${cfg.firebase.projectId}/databases/(default)/documents`, key: cfg.firebase.apiKey };
}
function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeFields(f) {
  const o = {};
  for (const k of Object.keys(f || {})) o[k] = decodeValue(f[k]);
  return o;
}
function decodeDoc(d) {
  const o = decodeFields(d.fields || {});
  o.id = d.name.split("/").pop();
  o._updated = d.updateTime;
  return o;
}
async function getDocREST(cfg, path, fetchFn = fetch) {
  const b = restBase(cfg);
  const r = await fetchFn(`${b.root}/${b.docs}/${path}?key=${encodeURIComponent(b.key)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("GET " + path + " " + r.status);
  return decodeDoc(await r.json());
}
async function listREST(cfg, path, fetchFn = fetch) {
  const b = restBase(cfg);
  const out = [];
  let token = "";
  for (let i = 0; i < 50; i++) {
    const r = await fetchFn(`${b.root}/${b.docs}/${path}?pageSize=300&key=${encodeURIComponent(b.key)}${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
    if (!r.ok) throw new Error("LIST " + path + " " + r.status);
    const j = await r.json();
    (j.documents || []).forEach((d) => out.push(decodeDoc(d)));
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return out;
}
async function resolveShopId(cfg, fetchFn = fetch) {
  if (cfg.STORE_SHOP_ID) return cfg.STORE_SHOP_ID;
  const c = await getDocREST(cfg, "site/config", fetchFn);
  return c && c.shopId || "";
}
var nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
var rupees = (p) => "\u20B9" + nf.format(Math.round(p || 0) / 100);
var rupeesPlain = (p) => (Math.round(p || 0) / 100).toFixed(2);
var pctOff = (price, mrp) => mrp && mrp > price ? Math.round((mrp - price) * 100 / mrp) : 0;
var catSlug = (c) => String(c || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "c-" + Array.from(String(c)).map((ch) => ch.codePointAt(0).toString(36)).join("").slice(0, 24);
var esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var waNumber = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) d = "91" + d;
  if (d.length === 11 && d[0] === "0") d = "91" + d.slice(1);
  return d;
};
var safeUrl = (u) => /^https:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "";
function visibleProducts(list) {
  return list.filter((p) => p && p.active !== false && p.slug && p.name);
}
function categoriesOf(sf, items) {
  const used = new Set(items.map((p) => p.category).filter(Boolean));
  const order = sf && sf.categories && sf.categories.length ? sf.categories : DEFAULT_CATS;
  const out = order.filter((c) => used.has(c));
  [...used].sort().forEach((c) => {
    if (!out.includes(c)) out.push(c);
  });
  return out;
}
var POLICIES = {
  shipping: {
    key: "policyShipping",
    title: "Shipping & Delivery Policy",
    text: (s) => `Orders placed on ${s.name} are confirmed by phone or WhatsApp before they are packed.

Delivery: we deliver to addresses in and around ${s.city || "our city"}. Most orders are delivered within 1\u20133 working days after confirmation. Delivery charges, if any, are shown at checkout.${s.freeDeliveryAbove ? " Delivery is free on orders above " + rupees(s.freeDeliveryAbove) + "." : ""}

Pickup: you can choose \u201CPickup from store\u201D at checkout and collect your order from our shop${s.address ? " at " + s.address : ""} once we tell you it is ready.

If an item becomes unavailable after you order, we will call you and offer a replacement or remove it from your order.

Questions? Contact us${s.phone ? " on " + s.phone : ""}${s.email ? " or " + s.email : ""}.`
  },
  returns: {
    key: "policyReturns",
    title: "Return & Refund Policy",
    text: (s) => `We want you to be happy with every purchase.

Returns: unused items in their original condition and packaging (with tags, where applicable) can be returned or exchanged within 7 days of delivery. Personal-care items, innerwear and items damaged by use cannot be returned.

Damaged or wrong item: tell us within 48 hours of delivery with a photo, and we will replace it or refund you.

Refunds: after we receive and check the item, refunds are made by UPI or cash within 5\u20137 working days. Delivery charges are not refundable unless the item was wrong or damaged.

To start a return, contact us${s.whatsapp || s.phone ? " on WhatsApp " + (s.whatsapp || s.phone) : ""} with your order number.`
  },
  privacy: {
    key: "policyPrivacy",
    title: "Privacy Policy",
    text: (s) => `${s.name} respects your privacy.

What we collect: when you place an order we collect your name, mobile number, delivery address and any note you write. Your cart and wishlist are stored only on your own phone.

Why: we use these details only to confirm, deliver and support your order, and to contact you about it. We do not sell or rent your details to anyone.

Payments: we accept UPI and cash. We never ask for card numbers, PINs or OTPs.

Your choices: you can ask us to correct or delete your details at any time by contacting us${s.email ? " at " + s.email : ""}${s.phone ? " or " + s.phone : ""}.`
  },
  terms: {
    key: "policyTerms",
    title: "Terms & Conditions",
    text: (s) => `By using this website and placing an order with ${s.name}, you agree to these terms.

Prices are in Indian Rupees (\u20B9) and include applicable taxes unless stated otherwise. Prices and availability can change without notice.

An order is accepted only after we confirm it with you by phone or WhatsApp. We may cancel an order if an item is unavailable or the details given are incorrect.

Payment is by UPI or cash on delivery/pickup.

Product photos are for illustration; actual colour and packaging may vary slightly.

These terms are governed by the laws of India.`
  }
};
var policyText = (sf, k) => sf && sf[POLICIES[k].key] && String(sf[POLICIES[k].key]).trim() || POLICIES[k].text(Object.assign({ name: DEFAULT_NAME }, sf || {}));
var SOCIALS = [["instagram", "Instagram"], ["facebook", "Facebook"], ["youtube", "YouTube"], ["twitter", "X"], ["telegram", "Telegram"], ["linkedin", "LinkedIn"]];
var socialLinks = (sf) => SOCIALS.map(([k, label]) => ({ k, label, url: safeUrl(sf && sf[k]) })).filter((x) => x.url);
var shopSlug = (sf) => {
  const s = catSlug(sf && sf.name || DEFAULT_NAME);
  return /^c-/.test(s) ? "liveshop" : s;
};
var shopPath = (sf) => "shop/" + shopSlug(sf) + "/";
function catCounts(sf, items) {
  return categoriesOf(sf, items).map((c) => ({ name: c, slug: catSlug(c), count: items.filter((p) => p.category === c).length }));
}
var sellsLine = (sf, items, n = 4) => {
  const cs = categoriesOf(sf, items);
  return cs.slice(0, n).join(", ") + (cs.length > n ? " & more" : "");
};
var homeTitleOf = (S) => S.name + (S.tagline ? " \u2013 " + S.tagline : " \u2013 Online Shopping: Clothes, Shoes, Watches & More");
var SOCIAL_ICON = {
  instagram: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm5.5-1.5h.01",
  facebook: "M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8.5a.5.5 0 0 1 .5-.5Z",
  youtube: "M3 8.5A3.5 3.5 0 0 1 6.5 5h11A3.5 3.5 0 0 1 21 8.5v7a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 15.5v-7ZM10 9v6l5-3-5-3Z",
  twitter: "M4 4l16 16M20 4L4 20",
  telegram: "M21 4 3 11l6 2 2 6 3-4 5 4 2-15ZM9 13l9-6-6 8",
  linkedin: "M4 9h4v11H4V9Zm2-5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm4 5h4v1.5c.6-1 1.8-1.8 3.5-1.8 2.6 0 3.5 1.7 3.5 4.3v7h-4v-6c0-1.2-.4-2-1.6-2-1.2 0-1.9.9-1.9 2v6h-3.5V9Z",
  whatsapp: "M4 20l1.3-4A8 8 0 1 1 8 18.7L4 20Zm5-11c0 3.5 2.5 6 6 6l1.3-1.5-2-1-1 .8c-1-.4-2-1.4-2.5-2.5l.8-1-1-2L9 9Z",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
  email: "M3 6h18v12H3V6Zm0 0 9 7 9-7",
  share: "M16 6l-4-4-4 4M12 2v14M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7",
  map: "M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Zm0-9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
};
var iconSvg = (k, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${SOCIAL_ICON[k] || ""}"/></svg>`;

// store/generate.mjs
var args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
var ROOT = args.root || join(dirname(fileURLToPath(import.meta.url)), "..");
var ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, "firebase-config.js"), "utf8"), ctx);
var CFG = ctx.window.BHAGIRATHA_CONFIG || {};
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  CFG.emulator = { host, firestorePort: +port };
}
if (process.env.FIREBASE_PROJECT) CFG.firebase.projectId = process.env.FIREBASE_PROJECT;
var SITE = (process.env.SITE_URL || CFG.SITE_URL || "https://example.com/").replace(/\/?$/, "/");
var BASEPATH = new URL(SITE).pathname;
var SHELL = readFileSync(join(ROOT, "tools", "shell.html"), "utf8");
var write = (rel, content) => {
  const f = join(ROOT, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
};
var jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
var bootJson = (o) => `<script type="application/json" id="boot-data">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
var abs = (rel) => SITE + rel;
async function main() {
  let shopId = "", sf = null, items = [];
  try {
    shopId = await resolveShopId(CFG);
    if (shopId) {
      [sf, items] = await Promise.all([getDocREST(CFG, `shops/${shopId}/public/storefront`), listREST(CFG, `shops/${shopId}/catalog`)]);
    }
  } catch (e) {
    if (/ 40[13]\b/.test(e.message)) {
      console.warn("::warning::The public catalog is not readable yet (" + e.message + '). Paste the new Firestore rules in the Firebase console. Building the "coming soon" pages.');
      shopId = "";
      sf = null;
      items = [];
    } else {
      console.error("Could not read the public catalog:", e.message);
      if (!args["allow-empty"]) process.exit(1);
    }
  }
  const S = Object.assign({ name: DEFAULT_NAME, delivery: true, pickup: true, cod: true, upi: true }, sf || {});
  items = visibleProducts(items).sort((a, b) => a.name.localeCompare(b.name));
  const cats = categoriesOf(S, items);
  console.log(`shop=${shopId || "(none yet)"} name="${S.name}" products=${items.length} categories=${cats.length}`);
  for (const d of ["p", "c", "img", "about", "policy", "shop"]) rmSync(join(ROOT, d), { recursive: true, force: true });
  const images = /* @__PURE__ */ new Map();
  const withImgs = items.filter((p) => p.imageCount > 0);
  for (let i = 0; i < withImgs.length; i += 8) {
    await Promise.all(withImgs.slice(i, i + 8).map(async (p) => {
      try {
        const d = await getDocREST(CFG, `shops/${shopId}/catalogImages/${p.id}`);
        const list = (d && d.images || []).filter((x) => typeof x === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(x)).slice(0, 5);
        images.set(p.id, list.map((u, n) => {
          const m = u.match(/^data:image\/(\w+);base64,(.*)$/);
          const ext = m[1] === "jpeg" ? "jpg" : m[1];
          const rel = `img/${p.slug}-${n + 1}.${ext}`;
          write(rel, Buffer.from(m[2], "base64"));
          return rel;
        }));
      } catch (e) {
        console.warn("images", p.slug, e.message);
      }
    }));
  }
  if (S.logo && /^data:image\/(jpeg|png|webp);base64,/.test(S.logo)) {
    const m = S.logo.match(/^data:image\/(\w+);base64,(.*)$/);
    write("img/logo." + (m[1] === "jpeg" ? "jpg" : m[1]), Buffer.from(m[2], "base64"));
    S._logoRel = "img/logo." + (m[1] === "jpeg" ? "jpg" : m[1]);
  }
  const firstImg = (p) => (images.get(p.id) || [])[0];
  const lean = (p) => {
    const o = Object.assign({}, p);
    delete o.thumb;
    return o;
  };
  const leanSf = sf ? Object.assign({}, sf, { logo: void 0, policyShipping: void 0, policyReturns: void 0, policyPrivacy: void 0, policyTerms: void 0 }) : null;
  const org = {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    "@id": SITE + "#store",
    name: S.name,
    url: SITE,
    description: S.tagline || S.about || void 0,
    logo: S._logoRel ? abs(S._logoRel) : abs("icons/icon-512.png"),
    image: S._logoRel ? abs(S._logoRel) : abs("icons/icon-512.png"),
    telephone: S.phone || void 0,
    email: S.email || void 0,
    address: S.address ? { "@type": "PostalAddress", streetAddress: S.address, addressLocality: S.city || void 0, addressCountry: "IN" } : void 0,
    sameAs: ["instagram", "facebook", "youtube", "twitter", "telegram", "linkedin"].map((k) => safeUrl(S[k])).filter(Boolean),
    currenciesAccepted: "INR",
    paymentAccepted: [S.upi !== false ? "UPI" : null, S.cod !== false ? "Cash" : null].filter(Boolean).join(", ")
  };
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: S.name,
    alternateName: S.name.replace(/\s+/g, ""),
    url: SITE,
    potentialAction: { "@type": "SearchAction", target: SITE + "?q={search_term_string}", "query-input": "required name=search_term_string" }
  };
  const head = ({ title, desc, path, image, type = "website", extra = "", noindex = false }) => [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(abs(path))}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="${esc(S.name)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(abs(path))}">`,
    `<meta property="og:image" content="${esc(image ? abs(image) : abs("icons/icon-512.png"))}">`,
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta property="og:locale" content="en_IN">`,
    extra
  ].join("\n");
  const SHOP = shopPath(S);
  const SOC = socialLinks(S);
  const WA = waNumber(S.whatsapp || S.phone);
  const SELLS = sellsLine(S, items);
  const logoHtml = (pre, cls) => S._logoRel ? `<img class="${cls}" src="${pre}${S._logoRel}" alt="${esc(S.name)} logo" width="64" height="64">` : `<span class="${cls} mono">${esc((S.name || "L")[0].toUpperCase())}</span>`;
  const socialRow = () => SOC.length ? `<div class="soc-row">${SOC.map((s) => `<a class="soc soc-${s.k}" href="${esc(s.url)}" target="_blank" rel="noopener me" aria-label="${esc(s.label)}" title="${esc(s.label)}">${iconSvg(s.k)}</a>`).join("")}</div>` : "";
  const shopCardHtml = (pre) => `<section class="shopcard" aria-label="Sold by"><div class="shopcard-head">${logoHtml(pre, "shop-logo")}<div class="shopcard-txt"><small class="muted">Sold by</small><a class="shopcard-name" href="${pre}${SHOP}">${esc(S.name)}</a>${S.tagline ? `<p class="shopcard-tag">${esc(S.tagline)}</p>` : ""}${SELLS ? `<p class="shopcard-sells">Sells: ${esc(SELLS)}</p>` : ""}</div></div><div class="shopcard-btns"><a class="btn primary sm" href="${pre}${SHOP}">View shop profile</a>${WA ? `<a class="btn wa-o sm" href="https://wa.me/${WA}" target="_blank" rel="noopener">${iconSvg("whatsapp", 18)} WhatsApp</a>` : ""}${S.phone ? `<a class="btn ghost sm" href="tel:${esc(S.phone)}">${iconSvg("phone", 18)} Call</a>` : ""}</div>${socialRow()}</section>`;
  const topbar = (pre) => `<header class="top"><div class="top-row wrap"><a class="logo" href="${pre}"><span class="logo-mark">${esc((S.name || "L")[0])}</span><span class="logo-name">${esc(S.name)}</span></a><div class="top-actions"><a class="ic-btn" href="${pre}${SHOP}" aria-label="Shop profile" title="Shop profile">\u{1F3EA}</a><a class="ic-btn" href="${pre}cart/" aria-label="Cart">\u{1F6D2}</a></div></div></header>`;
  const foot = (pre) => `<footer class="foot"><div class="wrap foot-grid"><div><b class="foot-name">${esc(S.name)}</b>${S.tagline ? `<p>${esc(S.tagline)}</p>` : ""}${S.address ? `<p>\u{1F4CD} ${esc(S.address)}</p>` : ""}${S.phone ? `<p>\u{1F4DE} <a href="tel:${esc(S.phone)}">${esc(S.phone)}</a></p>` : ""}${S.email ? `<p>\u2709\uFE0F <a href="mailto:${esc(S.email)}">${esc(S.email)}</a></p>` : ""}</div>` + (cats.length ? `<div><b>Shop by category</b><ul>${cats.map((c) => `<li><a href="${pre}c/${catSlug(c)}/">${esc(c)}</a></li>`).join("")}</ul></div>` : "") + `<div><b>Policies</b><ul><li><a href="${pre}${SHOP}">Shop profile</a></li><li><a href="${pre}about/">About &amp; contact</a></li>${Object.keys(POLICIES).map((k) => `<li><a href="${pre}policy/${k}/">${esc(POLICIES[k].title)}</a></li>`).join("")}</ul></div></div><div class="wrap foot-bottom"><span>\xA9 ${esc(S.name)}</span><a class="staff-link" rel="nofollow" href="${pre}panel/">Shopkeeper login</a></div></footer>`;
  const cardHtml = (p, pre) => {
    const img = firstImg(p);
    const off = pctOff(p.price, p.mrp);
    return `<article class="pcard${p.inStock ? "" : " oos"}"><a class="pcard-img" href="${pre}p/${p.slug}/">${img ? `<img class="pimg" src="${pre}${img}" alt="${esc(p.name)}" loading="lazy" width="400" height="400">` : `<div class="pimg ph"><span>\u{1F6CD}\uFE0F</span></div>`}${off ? `<span class="tag-off">${off}% off</span>` : ""}${p.inStock ? "" : '<span class="tag-oos">Out of stock</span>'}</a><div class="pcard-body"><a class="pname" href="${pre}p/${p.slug}/">${esc(p.name)}</a><div class="price"><b>${rupees(p.price)}</b>${off ? `<s>${rupees(p.mrp)}</s><span class="off">${off}% off</span>` : ""}</div></div></article>`;
  };
  const page = (pre, h, body, boot) => SHELL.replaceAll("__PRE__", pre).replace("<!--HEAD-->", h).replace("<!--BODY-->", topbar(pre) + `<main id="main" class="wrap">${body}</main>` + foot(pre) + (boot ? bootJson(boot) : ""));
  const verify = CFG.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(CFG.GOOGLE_SITE_VERIFICATION)}">` : "";
  const urls = [];
  const lastmodOf = (p) => (p._updated || "").slice(0, 10);
  const newest = items.map(lastmodOf).sort().pop() || "";
  const homeTitle = homeTitleOf(S);
  const homeDesc = (S.tagline ? S.tagline + ". " : "") + `Shop ${cats.length ? cats.join(", ") : "products"} online at ${S.name}. Pay by UPI or cash, order on WhatsApp.`;
  const homeBody = `<section class="hero"><h1>${esc(S.name)}</h1>${S.tagline ? `<p class="tagline">${esc(S.tagline)}</p>` : ""}</section>` + (cats.length ? `<div class="chips-wrap"><div class="chips">${cats.map((c) => `<a class="chip" href="c/${catSlug(c)}/">${esc(c)}</a>`).join("")}</div></div>` : "") + (items.length ? `<section class="grid">${items.map((p) => cardHtml(p, "")).join("")}</section>` : `<section class="empty soon"><div class="big">\u{1F6CD}\uFE0F</div><h2>Products coming soon</h2></section>`);
  write("index.html", page("", head({ title: homeTitle, desc: homeDesc.slice(0, 300), path: "", image: S._logoRel, extra: verify + "\n" + jsonLd(org) + "\n" + jsonLd(website) }), homeBody, { sf: leanSf, items: items.map(lean) }));
  urls.push({ loc: SITE, lastmod: newest, priority: "1.0" });
  for (const p of items) {
    const pre = "../../";
    const imgs = images.get(p.id) || [];
    const off = pctOff(p.price, p.mrp);
    const title = `${p.name} \u2013 ${rupees(p.price)} \u2013 ${S.name}`;
    const desc = (p.description ? p.description.replace(/\s+/g, " ").slice(0, 150) + " " : "") + `Buy ${p.name} at ${rupees(p.price)}${off ? ` (${off}% off MRP ${rupees(p.mrp)})` : ""} from ${S.name}. ${p.inStock ? "In stock." : "Currently out of stock."}`;
    const ld = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: p.name,
      sku: p.id,
      url: abs(`p/${p.slug}/`),
      image: imgs.length ? imgs.map(abs) : void 0,
      description: p.description || `${p.name} from ${S.name}`,
      category: p.category || void 0,
      brand: { "@type": "Brand", name: S.name },
      offers: {
        "@type": "Offer",
        url: abs(`p/${p.slug}/`),
        priceCurrency: "INR",
        price: rupeesPlain(p.price),
        availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        itemCondition: "https://schema.org/NewCondition",
        seller: { "@type": "OnlineStore", name: S.name, url: abs(SHOP) }
      }
    };
    const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: S.name, item: SITE },
      ...p.category ? [{ "@type": "ListItem", position: 2, name: p.category, item: abs(`c/${catSlug(p.category)}/`) }] : [],
      { "@type": "ListItem", position: p.category ? 3 : 2, name: p.name, item: abs(`p/${p.slug}/`) }
    ] };
    const body = `<nav class="crumbs"><a href="${pre}">Home</a>${p.category ? ` \u203A <a href="${pre}c/${catSlug(p.category)}/">${esc(p.category)}</a>` : ""} \u203A <span>${esc(p.name)}</span></nav><div class="pdp"><div class="pdp-grid"><div class="pdp-media"><div class="gallery">${imgs.length ? imgs.map((im, i) => `<div class="slide"><img class="gimg" src="${pre}${im}" alt="${esc(p.name)} ${i + 1}" width="800" height="800"></div>`).join("") : '<div class="slide"><div class="gimg ph"><span>\u{1F6CD}\uFE0F</span></div></div>'}</div></div><div class="pdp-info"><h1 class="pdp-name">${esc(p.name)}</h1><div class="price big"><b>${rupees(p.price)}</b>${off ? `<s>${rupees(p.mrp)}</s><span class="off">${off}% off</span>` : ""}</div><div class="stock ${p.inStock ? "ok" : "no"}">\u25CF ${p.inStock ? "In stock" : "Out of stock"}</div>` + (p.description ? `<section class="desc"><h2>Description</h2>${p.description.split(/\n+/).map((x) => `<p>${esc(x)}</p>`).join("")}</section>` : "") + `<table class="specs"><tbody>${p.category ? `<tr><th>Category</th><td>${esc(p.category)}</td></tr>` : ""}${p.unit ? `<tr><th>Unit</th><td>${esc(p.unit)}</td></tr>` : ""}</tbody></table>${shopCardHtml(pre)}</div></div></div>`;
    write(`p/${p.slug}/index.html`, page(pre, head({
      title,
      desc: desc.slice(0, 300),
      path: `p/${p.slug}/`,
      image: imgs[0],
      type: "product",
      extra: `<meta property="product:price:amount" content="${rupeesPlain(p.price)}"><meta property="product:price:currency" content="INR">
` + jsonLd(ld) + "\n" + jsonLd(crumbs)
    }), body, { sf: leanSf, items: [lean(p)] }));
    urls.push({ group: "products", loc: abs(`p/${p.slug}/`), lastmod: lastmodOf(p), priority: "0.8", images: imgs.map((im) => ({ loc: abs(im), title: p.name })) });
  }
  for (const c of cats) {
    const pre = "../../";
    const list = items.filter((p) => p.category === c);
    const slug = catSlug(c);
    const ld = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${c} \u2013 ${S.name}`,
      url: abs(`c/${slug}/`),
      mainEntity: { "@type": "ItemList", itemListElement: list.slice(0, 100).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: abs(`p/${p.slug}/`), name: p.name })) }
    };
    const body = `<nav class="crumbs"><a href="${pre}">Home</a> \u203A <span>${esc(c)}</span></nav><h1 class="page-title">${esc(c)}</h1><section class="grid">${list.map((p) => cardHtml(p, pre)).join("")}</section>`;
    write(`c/${slug}/index.html`, page(pre, head({ title: `${c} \u2013 Buy Online \u2013 ${S.name}`, desc: `Shop ${c} online at ${S.name}: ${list.slice(0, 6).map((p) => p.name).join(", ")}. Best prices, UPI or cash payment.`.slice(0, 300), path: `c/${slug}/`, image: list.map(firstImg).find(Boolean), extra: jsonLd(ld) }), body, null));
    urls.push({ loc: abs(`c/${slug}/`), lastmod: list.map(lastmodOf).sort().pop() || "", priority: "0.7" });
  }
  {
    const pre = "../";
    const map = safeUrl(S.mapUrl);
    const wa = waNumber(S.whatsapp || S.phone);
    const body = `<h1 class="page-title">About ${esc(S.name)}</h1><p><a class="btn ghost sm" href="${pre}${SHOP}">\u{1F3EA} View our shop profile</a></p><section class="box">${S.tagline ? `<p>${esc(S.tagline)}</p>` : ""}${(S.about || "").split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join("")}</section><section class="box"><h2>Contact us</h2>${S.address ? `<p>\u{1F4CD} ${esc(S.address)}${S.city ? ", " + esc(S.city) : ""}</p>` : ""}${S.hours ? `<p>\u{1F558} ${esc(S.hours)}</p>` : ""}${S.phone ? `<p>\u{1F4DE} <a href="tel:${esc(S.phone)}">${esc(S.phone)}</a></p>` : ""}${wa ? `<p>\u{1F4AC} <a href="https://wa.me/${wa}">WhatsApp</a></p>` : ""}${S.email ? `<p>\u2709\uFE0F <a href="mailto:${esc(S.email)}">${esc(S.email)}</a></p>` : ""}${map ? `<p>\u{1F5FA} <a href="${esc(map)}">Get directions</a></p>` : ""}</section>`;
    write("about/index.html", page(pre, head({ title: `About & Contact \u2013 ${S.name}`, desc: `Contact ${S.name}${S.address ? ", " + S.address : ""}${S.phone ? ", phone " + S.phone : ""}.`.slice(0, 300), path: "about/", extra: jsonLd(org) }), body, null));
    urls.push({ loc: abs("about/"), lastmod: (sf && sf._updated || "").slice(0, 10), priority: "0.5" });
  }
  for (const k of Object.keys(POLICIES)) {
    const pre = "../../";
    const txt = policyText(S, k);
    write(`policy/${k}/index.html`, page(
      pre,
      head({ title: `${POLICIES[k].title} \u2013 ${S.name}`, desc: txt.replace(/\s+/g, " ").slice(0, 160), path: `policy/${k}/` }),
      `<article class="policy box"><h1>${esc(POLICIES[k].title)}</h1>${txt.split(/\n+/).map((x) => `<p>${esc(x)}</p>`).join("")}</article>`,
      null
    ));
    urls.push({ loc: abs(`policy/${k}/`), lastmod: (sf && sf._updated || "").slice(0, 10), priority: "0.3" });
  }
  {
    const pre = "../../";
    const map = safeUrl(S.mapUrl);
    const cc = catCounts(S, items);
    const url = abs(SHOP);
    const logoAbs = S._logoRel ? abs(S._logoRel) : abs("icons/icon-512.png");
    const catWords = cc.slice(0, 4).map((x) => x.name).join(", ");
    const title = `${S.name} \u2013 Shop Profile${catWords ? " | " + catWords : ""}`;
    const desc = `${S.name}${S.tagline ? " \u2013 " + S.tagline : ""}. ${cc.length ? "Sells " + cc.map((x) => x.name).join(", ") + ". " : ""}${items.length} products online. Order on WhatsApp, pay by UPI or cash.`;
    const sameAs = SOC.map((s) => s.url);
    const ld = {
      "@context": "https://schema.org",
      "@type": "OnlineStore",
      "@id": url + "#shop",
      name: S.name,
      url,
      logo: logoAbs,
      image: logoAbs,
      description: (S.about || S.tagline || `${S.name} online shop`).slice(0, 500),
      sameAs: sameAs.length ? sameAs : void 0,
      telephone: S.phone || void 0,
      email: S.email || void 0,
      address: S.address ? { "@type": "PostalAddress", streetAddress: S.address, addressLocality: S.city || void 0, addressCountry: "IN" } : void 0,
      contactPoint: S.phone || S.whatsapp || S.email ? { "@type": "ContactPoint", contactType: "customer service", telephone: S.phone || S.whatsapp || void 0, email: S.email || void 0, availableLanguage: ["en", "gu", "hi"] } : void 0,
      openingHours: S.hours || void 0,
      hasMap: map || void 0,
      currenciesAccepted: "INR",
      hasOfferCatalog: cc.length ? { "@type": "OfferCatalog", name: `${S.name} products`, itemListElement: cc.map((x) => ({ "@type": "OfferCatalog", name: x.name, url: abs(`c/${x.slug}/`), numberOfItems: x.count })) } : void 0,
      makesOffer: items.slice(0, 50).map((p) => ({ "@type": "Offer", price: rupeesPlain(p.price), priceCurrency: "INR", availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", itemOffered: { "@type": "Product", name: p.name, url: abs(`p/${p.slug}/`) } }))
    };
    const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: SITE }, { "@type": "ListItem", position: 2, name: "Shop profile", item: url }] };
    const contact = [
      S.address ? `<li>${iconSvg("map", 18)}<span>${esc(S.address)}${S.city ? ", " + esc(S.city) : ""}</span></li>` : "",
      S.hours ? `<li>\u{1F558} <span>${esc(S.hours)}</span></li>` : "",
      S.phone ? `<li>${iconSvg("phone", 18)}<a href="tel:${esc(S.phone)}">${esc(S.phone)}</a></li>` : "",
      WA ? `<li>${iconSvg("whatsapp", 18)}<a href="https://wa.me/${WA}" target="_blank" rel="noopener">WhatsApp</a></li>` : "",
      S.email ? `<li>${iconSvg("email", 18)}<a href="mailto:${esc(S.email)}">${esc(S.email)}</a></li>` : "",
      map ? `<li>\u{1F5FA} <a href="${esc(map)}" target="_blank" rel="noopener">Get directions</a></li>` : ""
    ].join("");
    const body = `<nav class="crumbs"><a href="${pre}">Home</a> \u203A <span>Shop profile</span></nav><section class="sp-hero"><div class="sp-cover" aria-hidden="true"></div><div class="sp-id">${logoHtml(pre, "sp-logo")}<div><h1 class="sp-name">${esc(S.name)}</h1>${S.tagline ? `<p class="sp-tag">${esc(S.tagline)}</p>` : ""}<p class="sp-meta">${items.length} products${cc.length ? " \xB7 " + cc.length + " categories" : ""}${S.city ? " \xB7 " + esc(S.city) : ""}</p></div></div><div class="sp-actions">${WA ? `<a class="btn wa sm" href="https://wa.me/${WA}" target="_blank" rel="noopener">${iconSvg("whatsapp", 18)} WhatsApp</a>` : ""}${S.phone ? `<a class="btn ghost sm" href="tel:${esc(S.phone)}">${iconSvg("phone", 18)} Call</a>` : ""}<a class="btn ghost sm" id="spShare" href="https://wa.me/?text=${encodeURIComponent(S.name + " \u2013 " + url)}" target="_blank" rel="noopener">${iconSvg("share", 18)} Share</a></div>${socialRow()}</section><section class="box"><h2>About</h2>${(S.about || S.tagline || `${S.name} is an online shop. Browse the products below and order on WhatsApp.`).split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join("")}</section>` + (cc.length ? `<section class="box"><h2>What we sell</h2><div class="chips">${cc.map((x) => `<a class="chip" href="${pre}c/${x.slug}/">${esc(x.name)} <span class="cnt">${x.count}</span></a>`).join("")}</div></section>` : "") + `<section><h2 class="sec-title">All products</h2>${items.length ? `<div class="grid">${items.map((p) => cardHtml(p, pre)).join("")}</div>` : '<p class="muted">Products coming soon.</p>'}</section>` + (contact ? `<section class="box"><h2>Contact</h2><ul class="sp-contact">${contact}</ul></section>` : "");
    write(`${SHOP}index.html`, page(pre, head({ title, desc: desc.slice(0, 300), path: SHOP, image: S._logoRel, type: "profile", extra: jsonLd(ld) + "\n" + jsonLd(crumbs) }), body, { sf: leanSf, items: items.map(lean) }));
    urls.push({ group: "shop", loc: url, lastmod: [newest, (sf && sf._updated || "").slice(0, 10)].sort().pop() || "", priority: "0.9", images: [{ loc: logoAbs, title: S.name + " logo" }] });
  }
  write("404.html", page(BASEPATH, head({ title: `Page not found \u2013 ${S.name}`, desc: S.name, path: "", noindex: true }), `<section class="empty"><div class="big">\u{1F9ED}</div><h1>Page not found</h1><p><a class="btn primary" href="${BASEPATH}">Go to the store</a></p></section>`, null));
  const urlset = (list) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...list.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority>${(u.images || []).map((im) => `<image:image><image:loc>${esc(im.loc)}</image:loc><image:title>${esc(im.title)}</image:title></image:image>`).join("")}</url>`),
    "</urlset>",
    ""
  ].join("\n");
  const groups = { pages: urls.filter((u) => !u.group), products: urls.filter((u) => u.group === "products"), shop: urls.filter((u) => u.group === "shop") };
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  for (const [k, list] of Object.entries(groups)) write(`sitemap-${k}.xml`, urlset(list));
  write("sitemap.xml", [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...Object.entries(groups).map(([k, list]) => `  <sitemap><loc>${esc(abs(`sitemap-${k}.xml`))}</loc><lastmod>${list.map((u) => u.lastmod).filter(Boolean).sort().pop() || today}</lastmod></sitemap>`),
    "</sitemapindex>",
    ""
  ].join("\n"));
  write("robots.txt", `User-agent: *
Allow: /
Disallow: ${BASEPATH}panel/
Disallow: ${BASEPATH}cart/
Disallow: ${BASEPATH}checkout/

Sitemap: ${SITE}sitemap.xml
Sitemap: ${SITE}sitemap-shop.xml
`);
  console.log(`wrote ${urls.length} sitemap URLs, ${items.length} product pages, ${cats.length} category pages, ${[...images.values()].reduce((a, l) => a + l.length, 0)} images`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
