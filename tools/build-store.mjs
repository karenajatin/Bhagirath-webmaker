// store/generate.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// store/brand.js
var SITE_NAME = "LiveShop Platform India";
var SITE_SHORT = "LiveShop";
var SHOP_SUFFIX = "Shop India";
var norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
var BRAND_WORDS = [.../* @__PURE__ */ new Set(["liveshop", norm(SITE_NAME), norm(SITE_SHORT), "liveshopindia", "liveshopplatform"])];
var isBrandWord = (n) => BRAND_WORDS.includes(norm(n));
function shopBaseName(n) {
  let s = String(n || "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 5; i++) {
    const t2 = s.replace(/[\s\-–—,.|:]*\bshop[\s\-–—_.]*india$/i, "").trim();
    if (t2 === s) break;
    s = t2;
  }
  const t = s.replace(/[\s\-–—,.|:]+shop$/i, "").trim();
  if (t) s = t;
  return s.replace(/[\s\-–—,.|:]+$/, "").slice(0, 80 - SHOP_SUFFIX.length - 1).trim();
}
var shopFullName = (n) => {
  const b = shopBaseName(n);
  return b ? b + " " + SHOP_SUFFIX : "";
};
var isBrandName = (n) => isBrandWord(n) || isBrandWord(shopBaseName(n));

// store/common.js
var DEFAULT_NAME = SITE_NAME;
var BRAND = SITE_NAME;
var brandParts = (n = SITE_NAME) => {
  const i = String(n).indexOf(" ");
  return i > 0 ? [n.slice(0, i), n.slice(i + 1)] : [String(n), ""];
};
var BRAND_TAGLINE = "Online Shopping: Clothes, Shoes, Watches & More";
var BRAND_SLUGS = ["liveshop", "live-shop", "shop", "shops"];
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
var shopSlug = (sf, id) => {
  const s = catSlug(shopBaseName(sf && sf.name || ""));
  return !s || /^c-/.test(s) || BRAND_SLUGS.includes(s) ? "shop-" + String(id || "x").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : s;
};
function catCounts(sf, items) {
  return categoriesOf(sf, items).map((c) => ({ name: c, slug: catSlug(c), count: items.filter((p) => p.category === c).length }));
}
var sellsList = (sf, items) => {
  const cs = categoriesOf(sf, items);
  if (cs.length) return cs;
  const own = sf && sf.categories || [];
  return own.join() === DEFAULT_CATS.join() ? [] : own.slice();
};
var sellsLine = (sf, items, n = 4) => {
  const cs = sellsList(sf, items);
  return cs.slice(0, n).join(", ") + (cs.length > n ? " & more" : "");
};
var shopTitleOf = (shop) => {
  const sf = shop.sf || {};
  const what = sf.tagline || sellsLine(sf, shop.items || [], 4);
  return shop.name + (what ? " \u2013 " + what : "") + (sf.city ? (what ? ", " : " \u2013 ") + sf.city : "") + " | " + BRAND;
};
function siteOf(homeSf) {
  const h = homeSf || {};
  const o = { name: BRAND, delivery: true, pickup: true, cod: true, upi: true };
  for (const k of ["announcement", "policyShipping", "policyReturns", "policyPrivacy", "policyTerms"]) if (h[k]) o[k] = h[k];
  return o;
}
var homeTitleOf = (S) => BRAND + " \u2013 " + BRAND_TAGLINE;
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
var productKey = (shop, p) => shop.home ? p.slug : shop.slug + "--" + p.slug;
var shopUrlPath = (shop) => "shop/" + shop.slug + "/";
function isDenied(e) {
  return / 40[13]\b/.test(e && e.message || "");
}
async function loadShops(cfg, fetchFn = fetch) {
  const homeId = await resolveShopId(cfg, fetchFn);
  let pubs = [], marketOn = false;
  try {
    pubs = await listREST(cfg, "publicShops", fetchFn);
    marketOn = true;
  } catch (e) {
    if (!isDenied(e)) throw e;
  }
  const list = [];
  const homePub = pubs.find((x) => x.id === homeId);
  if (homeId && !(homePub && homePub.active === false)) list.push({ id: homeId, home: true, slug: homePub && homePub.slug, name: homePub && homePub.name });
  pubs.filter((x) => x.id !== homeId && x.active !== false && x.slug && x.name && !BRAND_SLUGS.includes(x.slug) && !isBrandName(x.name)).sort((a, b) => String(a.slug).localeCompare(String(b.slug))).forEach((x) => list.push({ id: x.id, home: false, slug: x.slug, name: x.name }));
  const shops = await Promise.all(list.map(async (s) => {
    let sf = null, items = [];
    try {
      [sf, items] = await Promise.all([getDocREST(cfg, `shops/${s.id}/public/storefront`, fetchFn), listREST(cfg, `shops/${s.id}/catalog`, fetchFn)]);
    } catch (e) {
      if (s.home) throw e;
      console.warn("shop", s.id, e.message);
    }
    return finishShop(s, sf, items);
  }));
  return { homeId, marketOn, shops };
}
function finishShop(s, sf, items) {
  const nm = shopFullName([sf && sf.name, s.name].map((x) => String(x || "").trim()).find((x) => x && !isBrandName(x)) || "");
  const shop = Object.assign({}, s, { name: nm, sf: Object.assign({ delivery: true, pickup: true, cod: true, upi: true }, sf || {}, { name: nm }) });
  const slugOk = s.slug && !BRAND_SLUGS.includes(s.slug);
  shop.listed = !!nm;
  shop.slug = slugOk ? s.slug : nm ? shopSlug(shop.sf, s.id) : "";
  shop.items = visibleProducts(items || []).map((p) => Object.assign({}, p, { shopId: s.id, key: productKey(shop, p) }));
  return shop;
}

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
var dataImg = (u) => {
  const m = typeof u === "string" && u.match(/^data:image\/(jpeg|png|webp);base64,(.*)$/);
  return m ? { ext: m[1] === "jpeg" ? "jpg" : m[1], buf: Buffer.from(m[2], "base64") } : null;
};
async function main() {
  let shops = [], marketOn = false;
  try {
    const r = await loadShops(CFG);
    shops = r.shops;
    marketOn = r.marketOn;
  } catch (e) {
    if (isDenied(e)) {
      console.warn("::warning::The public catalog is not readable yet (" + e.message + '). Paste the new Firestore rules in the Firebase console. Building the "coming soon" pages.');
      shops = [];
    } else {
      console.error("Could not read the public catalog:", e.message);
      if (!args["allow-empty"]) process.exit(1);
    }
  }
  const home = shops.find((x) => x.home) || null;
  const S = siteOf(home ? home.sf : null);
  const profiled = shops.filter((x) => x.listed && x.slug);
  for (const shop of shops) shop.items.sort((a, b) => a.name.localeCompare(b.name));
  const items = shops.flatMap((x) => x.items).sort((a, b) => a.name.localeCompare(b.name));
  const shopById = new Map(shops.map((x) => [x.id, x]));
  const shopOf = (p) => shopById.get(p.shopId);
  const cats = categoriesOf(S, items);
  console.log(`marketplace=${marketOn ? "on" : "off (rules v3 not published)"} shops=${shops.length} [${shops.map((x) => (x.listed ? x.slug : "(no public name yet)") + ":" + x.items.length).join(", ")}] products=${items.length} categories=${cats.length}`);
  for (const d of ["p", "c", "img", "about", "policy", "shop", "shops"]) rmSync(join(ROOT, d), { recursive: true, force: true });
  for (const f of readdirSync(ROOT)) if (/^sitemap-shop-.+\.xml$/.test(f)) rmSync(join(ROOT, f), { force: true });
  const images = /* @__PURE__ */ new Map();
  const withImgs = items.filter((p) => p.imageCount > 0);
  for (let i = 0; i < withImgs.length; i += 8) {
    await Promise.all(withImgs.slice(i, i + 8).map(async (p) => {
      try {
        const d = await getDocREST(CFG, `shops/${p.shopId}/catalogImages/${p.id}`);
        const list = (d && d.images || []).map(dataImg).filter(Boolean).slice(0, 5);
        images.set(p.id, list.map((x, n) => {
          const rel = `img/${p.key}-${n + 1}.${x.ext}`;
          write(rel, x.buf);
          return rel;
        }));
      } catch (e) {
        console.warn("images", p.key, e.message);
      }
    }));
  }
  for (const shop of shops) {
    const lg = dataImg(shop.sf.logo);
    if (lg) {
      shop._logoRel = shop.home ? `img/logo.${lg.ext}` : `img/logo-${shop.slug}.${lg.ext}`;
      write(shop._logoRel, lg.buf);
    }
    const cv = dataImg(shop.sf.cover);
    if (cv) {
      shop._coverRel = `img/cover-${shop.slug}.${cv.ext}`;
      write(shop._coverRel, cv.buf);
    }
  }
  const firstImg = (p) => (images.get(p.id) || [])[0];
  const lean = (p) => {
    const o = Object.assign({}, p);
    delete o.thumb;
    return o;
  };
  const leanShop = (shop, list) => ({
    id: shop.id,
    home: shop.home,
    slug: shop.slug,
    name: shop.name,
    listed: shop.listed,
    sf: Object.assign({}, shop.sf, { logo: void 0, cover: void 0, policyShipping: void 0, policyReturns: void 0, policyPrivacy: void 0, policyTerms: void 0 }),
    items: (list || shop.items).map(lean)
  });
  const org = {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    "@id": SITE + "#store",
    name: S.name,
    alternateName: SITE_SHORT,
    url: SITE,
    description: "Online shopping from local shops: " + BRAND_TAGLINE.replace(/^Online Shopping: /, ""),
    logo: abs("icons/icon-512.png"),
    image: abs("icons/icon-512.png"),
    currenciesAccepted: "INR",
    paymentAccepted: "UPI, Cash"
  };
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: S.name,
    alternateName: SITE_SHORT,
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
  const logoHtml = (shop, pre, cls) => shop && shop._logoRel ? `<img class="${cls}" src="${pre}${shop._logoRel}" alt="${esc(shop.name)} logo" width="64" height="64">` : `<span class="${cls} mono">${esc((shop && shop.name || "L")[0].toUpperCase())}</span>`;
  const socialRow = (sf) => {
    const SOC = socialLinks(sf);
    return SOC.length ? `<div class="soc-row">${SOC.map((s) => `<a class="soc soc-${s.k}" href="${esc(s.url)}" target="_blank" rel="noopener me" aria-label="${esc(s.label)}" title="${esc(s.label)}">${iconSvg(s.k)}</a>`).join("")}</div>` : "";
  };
  const shopCardHtml = (shop, pre) => {
    if (!shop || !shop.listed) return "";
    const sf = shop.sf;
    const SP = shopUrlPath(shop);
    const WA = waNumber(sf.whatsapp || sf.phone);
    const SELLS = sellsLine(sf, shop.items);
    return `<section class="shopcard" aria-label="Sold by"><div class="shopcard-head">${logoHtml(shop, pre, "shop-logo")}<div class="shopcard-txt"><small class="muted">Sold by</small><a class="shopcard-name" href="${pre}${SP}">${esc(shop.name)}</a>${sf.tagline ? `<p class="shopcard-tag">${esc(sf.tagline)}</p>` : ""}${SELLS ? `<p class="shopcard-sells">Sells: ${esc(SELLS)}</p>` : ""}</div></div><div class="shopcard-btns"><a class="btn primary sm" href="${pre}${SP}">View shop profile</a>${WA ? `<a class="btn wa-o sm" href="https://wa.me/${WA}" target="_blank" rel="noopener">${iconSvg("whatsapp", 18)} WhatsApp</a>` : ""}${sf.phone ? `<a class="btn ghost sm" href="tel:${esc(sf.phone)}">${iconSvg("phone", 18)} Call</a>` : ""}</div>${socialRow(sf)}</section>`;
  };
  const topbar = (pre) => `<header class="top"><div class="top-row wrap"><a class="logo" href="${pre}"><span class="logo-mark">${esc((S.name || "L")[0])}</span><span class="logo-name">${brandParts(S.name).map((x, i) => x ? i ? `<small>${esc(x)}</small>` : `<b>${esc(x)}</b>` : "").join("")}</span></a><div class="top-actions"><a class="ic-btn" href="${pre}shops/" aria-label="All shops" title="All shops">\u{1F3EA}</a><a class="ic-btn" href="${pre}cart/" aria-label="Cart">\u{1F6D2}</a></div></div></header>`;
  const foot = (pre) => `<footer class="foot"><div class="wrap foot-grid"><div><b class="foot-name">${esc(S.name)}</b><p>Online shopping from local shops</p>${profiled.length ? `<p><a href="${pre}shops/">${profiled.length} shop${profiled.length > 1 ? "s" : ""} on ${esc(S.name)}</a></p>` : ""}</div>` + (cats.length ? `<div><b>Shop by category</b><ul>${cats.map((c) => `<li><a href="${pre}c/${catSlug(c)}/">${esc(c)}</a></li>`).join("")}</ul></div>` : "") + `<div><b>Policies</b><ul><li><a href="${pre}shops/">All shops</a></li><li><a href="${pre}about/">About &amp; contact</a></li>${Object.keys(POLICIES).map((k) => `<li><a href="${pre}policy/${k}/">${esc(POLICIES[k].title)}</a></li>`).join("")}</ul></div></div><div class="wrap foot-bottom"><span>\xA9 ${esc(S.name)}</span><a class="staff-link" rel="nofollow" href="${pre}panel/">Shopkeeper login</a></div></footer>`;
  const cardHtml = (p, pre) => {
    const img = firstImg(p);
    const off = pctOff(p.price, p.mrp);
    const shop = shopOf(p);
    return `<article class="pcard${p.inStock ? "" : " oos"}"><a class="pcard-img" href="${pre}p/${p.key}/">${img ? `<img class="pimg" src="${pre}${img}" alt="${esc(p.name)}" loading="lazy" width="400" height="400">` : `<div class="pimg ph"><span>\u{1F6CD}\uFE0F</span></div>`}${off ? `<span class="tag-off">${off}% off</span>` : ""}${p.inStock ? "" : '<span class="tag-oos">Out of stock</span>'}</a><div class="pcard-body"><a class="pname" href="${pre}p/${p.key}/">${esc(p.name)}</a><div class="price"><b>${rupees(p.price)}</b>${off ? `<s>${rupees(p.mrp)}</s><span class="off">${off}% off</span>` : ""}</div>` + (shop && shop.listed ? `<small class="pseller">Sold by <a class="pseller-a" href="${pre}${shopUrlPath(shop)}">${esc(shop.name)}</a></small>` : "") + `</div></article>`;
  };
  const page = (pre, h, body, boot) => SHELL.replaceAll("__PRE__", pre).replace("<!--HEAD-->", h).replace("<!--BODY-->", topbar(pre) + `<main id="main" class="wrap">${body}</main>` + foot(pre) + (boot ? bootJson(boot) : ""));
  const verify = CFG.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(CFG.GOOGLE_SITE_VERIFICATION)}">` : "";
  const urls = [];
  const lastmodOf = (p) => (p._updated || "").slice(0, 10);
  const newest = items.map(lastmodOf).sort().pop() || "";
  const sfMod = (shop) => (shop && shop.sf && shop.sf._updated || "").slice(0, 10);
  const homeTitle = homeTitleOf(S);
  const homeDesc = `${S.name}: online shopping from local shops. Buy ${cats.length ? cats.join(", ") : "clothes, shoes, watches and more"}${profiled.length ? " from " + profiled.map((x) => x.name).slice(0, 5).join(", ") : ""}. Order on WhatsApp, pay by UPI or cash.`;
  const shopTileHtml = (x, pre) => `<a class="shop-tile" href="${pre}${shopUrlPath(x)}">${logoHtml(x, pre, "shop-logo")}<div class="shop-tile-txt"><b>${esc(x.name)}</b>${x.sf.tagline ? `<small>${esc(x.sf.tagline)}</small>` : ""}<small class="muted">${x.items.length} products${sellsLine(x.sf, x.items, 3) ? " \xB7 " + esc(sellsLine(x.sf, x.items, 3)) : ""}</small></div><span class="chev">\u203A</span></a>`;
  const homeBody = `<section class="hero"><h1>${esc(S.name)}</h1><p class="tagline">Online shopping from local shops: clothes, shoes, watches &amp; more</p></section>` + (cats.length ? `<div class="chips-wrap"><div class="chips">${cats.map((c) => `<a class="chip" href="c/${catSlug(c)}/">${esc(c)}</a>`).join("")}</div></div>` : "") + (items.length ? `<section class="grid">${items.map((p) => cardHtml(p, "")).join("")}</section>` : `<section class="empty soon"><div class="big">\u{1F6CD}\uFE0F</div><h2>Products coming soon</h2></section>`) + (profiled.length ? `<section class="shops-strip"><h2 class="sec-title">Shops on ${esc(S.name)}</h2><div class="shop-list">${profiled.map((x) => shopTileHtml(x, "")).join("")}</div></section>` : "");
  write("index.html", page("", head({ title: homeTitle, desc: homeDesc.slice(0, 300), path: "", image: null, extra: verify + "\n" + jsonLd(org) + "\n" + jsonLd(website) }), homeBody, { shops: shops.map((x) => leanShop(x)) }));
  urls.push({ loc: SITE, lastmod: newest, priority: "1.0" });
  for (const p of items) {
    const pre = "../../";
    const imgs = images.get(p.id) || [];
    const off = pctOff(p.price, p.mrp);
    const shop = shopOf(p);
    const SP = shopUrlPath(shop);
    const title = `${p.name} \u2013 ${rupees(p.price)} | ${shop.listed ? shop.name + " on " : ""}${S.name}`;
    const desc = (p.description ? p.description.replace(/\s+/g, " ").slice(0, 150) + " " : "") + `Buy ${p.name} at ${rupees(p.price)}${off ? ` (${off}% off MRP ${rupees(p.mrp)})` : ""}${shop.listed ? " from " + shop.name : ""} on ${S.name}. ${p.inStock ? "In stock." : "Currently out of stock."}`;
    const ld = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: p.name,
      sku: p.id,
      url: abs(`p/${p.key}/`),
      image: imgs.length ? imgs.map(abs) : void 0,
      description: p.description || `${p.name}${shop.listed ? " from " + shop.name : ""} on ${S.name}`,
      category: p.category || void 0,
      brand: shop.listed ? { "@type": "Brand", name: shop.name } : void 0,
      offers: {
        "@type": "Offer",
        url: abs(`p/${p.key}/`),
        priceCurrency: "INR",
        price: rupeesPlain(p.price),
        availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        itemCondition: "https://schema.org/NewCondition",
        seller: shop.listed ? { "@type": "Store", name: shop.name, url: abs(SP) } : { "@type": "Organization", name: S.name, url: SITE }
      }
    };
    const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: S.name, item: SITE },
      ...p.category ? [{ "@type": "ListItem", position: 2, name: p.category, item: abs(`c/${catSlug(p.category)}/`) }] : [],
      { "@type": "ListItem", position: p.category ? 3 : 2, name: p.name, item: abs(`p/${p.key}/`) }
    ] };
    const body = `<nav class="crumbs"><a href="${pre}">Home</a>${p.category ? ` \u203A <a href="${pre}c/${catSlug(p.category)}/">${esc(p.category)}</a>` : ""} \u203A <span>${esc(p.name)}</span></nav><div class="pdp"><div class="pdp-grid"><div class="pdp-media"><div class="gallery">${imgs.length ? imgs.map((im, i) => `<div class="slide"><img class="gimg" src="${pre}${im}" alt="${esc(p.name)} ${i + 1}" width="800" height="800"></div>`).join("") : '<div class="slide"><div class="gimg ph"><span>\u{1F6CD}\uFE0F</span></div></div>'}</div></div><div class="pdp-info"><h1 class="pdp-name">${esc(p.name)}</h1><div class="price big"><b>${rupees(p.price)}</b>${off ? `<s>${rupees(p.mrp)}</s><span class="off">${off}% off</span>` : ""}</div><div class="stock ${p.inStock ? "ok" : "no"}">\u25CF ${p.inStock ? "In stock" : "Out of stock"}</div>` + (p.description ? `<section class="desc"><h2>Description</h2>${p.description.split(/\n+/).map((x) => `<p>${esc(x)}</p>`).join("")}</section>` : "") + `<table class="specs"><tbody>${p.category ? `<tr><th>Category</th><td>${esc(p.category)}</td></tr>` : ""}${p.unit ? `<tr><th>Unit</th><td>${esc(p.unit)}</td></tr>` : ""}${shop.listed ? `<tr><th>Sold by</th><td><a href="${pre}${SP}">${esc(shop.name)}</a></td></tr>` : ""}</tbody></table>${shopCardHtml(shop, pre)}</div></div></div>`;
    write(`p/${p.key}/index.html`, page(pre, head({
      title,
      desc: desc.slice(0, 300),
      path: `p/${p.key}/`,
      image: imgs[0],
      type: "product",
      extra: `<meta property="product:price:amount" content="${rupeesPlain(p.price)}"><meta property="product:price:currency" content="INR">
` + jsonLd(ld) + "\n" + jsonLd(crumbs)
    }), body, { shops: [leanShop(shop, [p])] }));
    urls.push({ group: "products", shop: shop.listed ? shop.slug : "", loc: abs(`p/${p.key}/`), lastmod: lastmodOf(p), priority: "0.8", images: imgs.map((im) => ({ loc: abs(im), title: p.name })) });
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
      mainEntity: { "@type": "ItemList", itemListElement: list.slice(0, 100).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: abs(`p/${p.key}/`), name: p.name })) }
    };
    const body = `<nav class="crumbs"><a href="${pre}">Home</a> \u203A <span>${esc(c)}</span></nav><h1 class="page-title">${esc(c)}</h1><section class="grid">${list.map((p) => cardHtml(p, pre)).join("")}</section>`;
    write(`c/${slug}/index.html`, page(pre, head({ title: `${c} \u2013 Buy Online \u2013 ${S.name}`, desc: `Shop ${c} online at ${S.name}: ${list.slice(0, 6).map((p) => p.name).join(", ")}. Best prices, UPI or cash payment.`.slice(0, 300), path: `c/${slug}/`, image: list.map(firstImg).find(Boolean), extra: jsonLd(ld) }), body, null));
    urls.push({ loc: abs(`c/${slug}/`), lastmod: list.map(lastmodOf).sort().pop() || "", priority: "0.7" });
  }
  {
    const pre = "../";
    const body = `<h1 class="page-title">About ${esc(S.name)}</h1><section class="box"><p>${esc(S.name)} is a website where local shopkeepers open their own shop and sell online. Every shop has its own page with its products, contact details and social media.</p><p>You order directly from the shop on WhatsApp and pay the shop by UPI or cash.</p></section><section class="box"><h2>Contact</h2><p>To ask about an item or an order, contact the shop directly from its shop page.</p><p><a class="btn ghost sm" href="${pre}shops/">\u{1F3EA} All shops</a></p></section>` + (profiled.length ? `<section class="shops-strip"><h2 class="sec-title">Shops on ${esc(S.name)}</h2><div class="shop-list">${profiled.map((x) => shopTileHtml(x, pre)).join("")}</div></section>` : "");
    write("about/index.html", page(pre, head({ title: `About ${S.name} \u2013 Online shopping from local shops`, desc: `${S.name} is a website where local shops sell online. Order on WhatsApp, pay by UPI or cash.`, path: "about/", extra: jsonLd(org) }), body, null));
    urls.push({ loc: abs("about/"), lastmod: sfMod(home), priority: "0.5" });
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
    urls.push({ loc: abs(`policy/${k}/`), lastmod: sfMod(home), priority: "0.3" });
  }
  for (const shop of profiled) {
    const sf = shop.sf;
    const pre = "../../";
    const SP = shopUrlPath(shop);
    const list = shop.items;
    const WA = waNumber(sf.whatsapp || sf.phone);
    const map = safeUrl(sf.mapUrl);
    const cc = catCounts(sf, list);
    const url = abs(SP);
    const logoAbs = shop._logoRel ? abs(shop._logoRel) : abs("icons/icon-512.png");
    const sells = sellsList(sf, list);
    const title = shopTitleOf(shop);
    const desc = `${shop.name}${sf.tagline ? " \u2013 " + sf.tagline : ""}${sf.city ? ", " + sf.city : ""}. ${sells.length ? shop.name + " sells " + sells.join(", ") + ". " : ""}${list.length ? "Browse " + list.length + " products from " + shop.name + " online on " + S.name + ". " : "Shop profile on " + S.name + ". "}Order on WhatsApp, pay by UPI or cash.`;
    const sameAs = socialLinks(sf).map((s) => s.url);
    const ld = {
      "@context": "https://schema.org",
      "@type": "Store",
      "@id": url + "#shop",
      name: shop.name,
      alternateName: shopBaseName(shop.name) || void 0,
      url,
      logo: logoAbs,
      image: shop._coverRel ? [logoAbs, abs(shop._coverRel)] : logoAbs,
      description: (sf.about || sf.tagline || `${shop.name} online shop`).slice(0, 500),
      sameAs: sameAs.length ? sameAs : void 0,
      telephone: sf.phone || void 0,
      email: sf.email || void 0,
      address: sf.address ? { "@type": "PostalAddress", streetAddress: sf.address, addressLocality: sf.city || void 0, addressCountry: "IN" } : void 0,
      contactPoint: sf.phone || sf.whatsapp || sf.email ? { "@type": "ContactPoint", contactType: "customer service", telephone: sf.phone || sf.whatsapp || void 0, email: sf.email || void 0, availableLanguage: ["en", "gu", "hi"] } : void 0,
      openingHours: sf.hours || void 0,
      hasMap: map || void 0,
      currenciesAccepted: "INR",
      keywords: sells.length ? sells.join(", ") : void 0,
      isPartOf: { "@type": "WebSite", name: S.name, url: SITE },
      hasOfferCatalog: cc.length ? { "@type": "OfferCatalog", name: `${shop.name} products`, itemListElement: cc.map((x) => ({ "@type": "OfferCatalog", name: x.name, url: abs(`c/${x.slug}/`), numberOfItems: x.count })) } : void 0,
      makesOffer: list.slice(0, 50).map((p) => ({ "@type": "Offer", price: rupeesPlain(p.price), priceCurrency: "INR", availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", itemOffered: { "@type": "Product", name: p.name, url: abs(`p/${p.key}/`), offers: { "@type": "Offer", price: rupeesPlain(p.price), priceCurrency: "INR", availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", url: abs(`p/${p.key}/`) } } }))
    };
    const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: SITE }, { "@type": "ListItem", position: 2, name: "All shops", item: abs("shops/") }, { "@type": "ListItem", position: 3, name: shop.name, item: url }] };
    const contact = [
      sf.address ? `<li>${iconSvg("map", 18)}<span>${esc(sf.address)}${sf.city ? ", " + esc(sf.city) : ""}</span></li>` : "",
      sf.hours ? `<li>\u{1F558} <span>${esc(sf.hours)}</span></li>` : "",
      sf.phone ? `<li>${iconSvg("phone", 18)}<a href="tel:${esc(sf.phone)}">${esc(sf.phone)}</a></li>` : "",
      WA ? `<li>${iconSvg("whatsapp", 18)}<a href="https://wa.me/${WA}" target="_blank" rel="noopener">WhatsApp</a></li>` : "",
      sf.email ? `<li>${iconSvg("email", 18)}<a href="mailto:${esc(sf.email)}">${esc(sf.email)}</a></li>` : "",
      map ? `<li>\u{1F5FA} <a href="${esc(map)}" target="_blank" rel="noopener">Get directions</a></li>` : ""
    ].join("");
    const body = `<nav class="crumbs"><a href="${pre}">Home</a> \u203A <a href="${pre}shops/">All shops</a> \u203A <span>${esc(shop.name)}</span></nav><section class="sp-hero"><div class="sp-cover" aria-hidden="true">${shop._coverRel ? `<img class="sp-cover-img" src="${pre}${shop._coverRel}" alt="">` : ""}</div><div class="sp-id">${logoHtml(shop, pre, "sp-logo")}<div><h1 class="sp-name">${esc(shop.name)}</h1>${sf.tagline ? `<p class="sp-tag">${esc(sf.tagline)}</p>` : ""}<p class="sp-meta">${sells.length && !cc.length ? esc(sells.join(", ")) + " \xB7 " : ""}${list.length} products${cc.length ? " \xB7 " + cc.length + " categories" : ""}${sf.city ? " \xB7 " + esc(sf.city) : ""}</p></div></div><div class="sp-actions">${WA ? `<a class="btn wa sm" href="https://wa.me/${WA}" target="_blank" rel="noopener">${iconSvg("whatsapp", 18)} WhatsApp</a>` : ""}${sf.phone ? `<a class="btn ghost sm" href="tel:${esc(sf.phone)}">${iconSvg("phone", 18)} Call</a>` : ""}<a class="btn ghost sm" id="spShare" href="https://wa.me/?text=${encodeURIComponent(shop.name + " \u2013 " + url)}" target="_blank" rel="noopener">${iconSvg("share", 18)} Share</a></div>${socialRow(sf)}</section><section class="box"><h2>About</h2>${(sf.about || sf.tagline || `${shop.name} is an online shop. Browse the products below and order on WhatsApp.`).split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join("")}</section>` + (cc.length ? `<section class="box"><h2>What we sell</h2><div class="chips">${cc.map((x) => `<a class="chip" href="${pre}c/${x.slug}/">${esc(x.name)} <span class="cnt">${x.count}</span></a>`).join("")}</div></section>` : "") + `<section><h2 class="sec-title">All products</h2>${list.length ? `<div class="grid">${list.map((p) => cardHtml(p, pre)).join("")}</div>` : '<p class="muted">Products coming soon.</p>'}</section>` + (contact ? `<section class="box"><h2>Contact</h2><ul class="sp-contact">${contact}</ul></section>` : "");
    write(`${SP}index.html`, page(pre, head({ title, desc: desc.slice(0, 300), path: SP, image: shop._coverRel || shop._logoRel, type: "profile", extra: jsonLd(ld) + "\n" + jsonLd(crumbs) }), body, { shops: [leanShop(shop)] }));
    urls.push({
      group: "shop",
      shop: shop.slug,
      loc: url,
      lastmod: [list.map(lastmodOf).sort().pop() || "", sfMod(shop)].sort().pop() || "",
      priority: "0.9",
      images: [{ loc: logoAbs, title: shop.name + " logo" }, ...shop._coverRel ? [{ loc: abs(shop._coverRel), title: shop.name }] : []]
    });
  }
  {
    const pre = "../";
    const ld = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `All shops \u2013 ${S.name}`,
      url: abs("shops/"),
      mainEntity: { "@type": "ItemList", itemListElement: profiled.map((x, i) => ({ "@type": "ListItem", position: i + 1, url: abs(shopUrlPath(x)), name: x.name })) }
    };
    const body = `<nav class="crumbs"><a href="${pre}">Home</a> \u203A <span>All shops</span></nav><h1 class="page-title">All shops</h1>` + (profiled.length ? `<div class="shop-list">${profiled.map((x) => shopTileHtml(x, pre)).join("")}</div>` : '<p class="muted">Shops coming soon.</p>');
    write("shops/index.html", page(pre, head({ title: `Shops on ${S.name} \u2013 all sellers`, desc: `${profiled.length} shops sell on ${S.name}: ${profiled.slice(0, 8).map((x) => x.name).join(", ")}.`.slice(0, 300), path: "shops/", extra: jsonLd(ld) }), body, { shops: shops.map((x) => leanShop(x, [])) }));
    urls.push({ loc: abs("shops/"), lastmod: newest, priority: "0.6" });
  }
  for (const old of ["liveshop", "live-shop"]) if (!profiled.some((x) => x.slug === old))
    write(`shop/${old}/index.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shops on ${esc(S.name)}</title><meta name="robots" content="noindex, follow"><link rel="canonical" href="${esc(abs("shops/"))}"><meta http-equiv="refresh" content="0; url=../../shops/"></head><body><p><a href="../../shops/">Shops on ${esc(S.name)}</a></p></body></html>
`);
  write("404.html", page(BASEPATH, head({ title: `Page not found \u2013 ${S.name}`, desc: S.name, path: "", noindex: true }), `<section class="empty"><div class="big">\u{1F9ED}</div><h1>Page not found</h1><p><a class="btn primary" href="${BASEPATH}">Go to the store</a></p></section>`, null));
  const urlset = (list) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...list.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority>${(u.images || []).map((im) => `<image:image><image:loc>${esc(im.loc)}</image:loc><image:title>${esc(im.title)}</image:title></image:image>`).join("")}</url>`),
    "</urlset>",
    ""
  ].join("\n");
  const files = [
    ["sitemap-pages.xml", urls.filter((u) => !u.group)],
    ["sitemap-products.xml", urls.filter((u) => u.group === "products")],
    ["sitemap-shop.xml", urls.filter((u) => u.group === "shop")],
    ...profiled.map((x) => [`sitemap-shop-${x.slug}.xml`, urls.filter((u) => u.shop === x.slug)])
  ];
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  for (const [f, list] of files) write(f, urlset(list));
  write("sitemap.xml", [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...files.filter(([, list]) => list.length).map(([f, list]) => `  <sitemap><loc>${esc(abs(f))}</loc><lastmod>${list.map((u) => u.lastmod).filter(Boolean).sort().pop() || today}</lastmod></sitemap>`),
    "</sitemapindex>",
    ""
  ].join("\n"));
  write("robots.txt", `User-agent: *
Allow: /
Disallow: ${BASEPATH}panel/
Disallow: ${BASEPATH}cart/
Disallow: ${BASEPATH}checkout/

Sitemap: ${SITE}sitemap.xml
`);
  console.log(`wrote ${urls.length} sitemap URLs, ${files.length} sitemap files, ${items.length} product pages, ${profiled.length} shop profiles [${profiled.map((x) => x.slug).join(", ")}], ${cats.length} category pages, ${[...images.values()].reduce((a, l) => a + l.length, 0)} images`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
