/**
 * Seeds MongoDB with the catalog the client site was designed with, and uploads every image
 * from client-site/public/assets into GridFS.
 *
 *   pnpm seed          idempotent: inserts what is missing, never overwrites admin edits
 *   pnpm seed:fresh    wipes catalog/content collections (NOT users, bookings, orders, payments) and reseeds
 *   --media            re-upload images even if they already exist
 *
 * Source data: seed/data.json (extracted from client-site/src/data/*.ts).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { connectDB, disconnectDB } from "../config/db.js";
import { AddOn, Admin, Banner, Category, Chadhava, Coupon, Faq, Page, Post, Product, Puja, Review, Setting, Temple } from "../models/index.js";
import { contentTypeFor, putFile } from "../services/media.js";
import { DEFAULT_SITE } from "../services/settings.js";
import { logger } from "../utils/logger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const FRESH = args.has("--fresh");
const FORCE_MEDIA = args.has("--media") || FRESH;

const raw = JSON.parse(await fs.readFile(path.join(here, "data.json"), "utf8"));

/* ───────── helpers ───────── */
const DAY = 86_400_000;
const IST = 330 * 60_000;
const istDayStart = (ms) => Math.floor((ms + IST) / DAY) * DAY - IST;
const NOW = Date.now();

/** "REL:days:hour:minute" (IST) → Date relative to today; anything else passes through. */
const rel = (v) => {
  if (typeof v !== "string" || !v.startsWith("REL:")) return v;
  const [, d, h, m] = v.split(":").map(Number);
  return new Date(istDayStart(NOW) + d * DAY + (h * 60 + m) * 60_000);
};

/** Rewrites /assets/images/x.webp → /media/x.webp and /assets/brand/x → /media/brand/x everywhere. */
function rewrite(v) {
  if (typeof v === "string") return v.replace(/^\/assets\/images\//, "/media/").replace(/^\/assets\/brand\//, "/media/brand/");
  if (Array.isArray(v)) return v.map(rewrite);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
  return v;
}
const data = rewrite(raw);

async function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Insert when missing (by `key`), or replace everything in fresh mode. */
async function upsertMany(Model, docs, key) {
  let inserted = 0;
  for (const d of docs) {
    const res = await Model.updateOne({ [key]: d[key] }, { $setOnInsert: d }, { upsert: true });
    if (res.upsertedCount) inserted++;
  }
  logger.info(`${Model.modelName}: ${inserted} inserted, ${docs.length - inserted} already present`);
}

/* ───────── 1. media ───────── */
async function seedMedia() {
  const root = path.resolve(process.cwd(), env.SEED_ASSETS_DIR);
  const files = [
    ...(await walk(path.join(root, "images"))).map((f) => ({ f, key: path.relative(path.join(root, "images"), f).split(path.sep).join("/") })),
    ...(await walk(path.join(root, "brand"))).map((f) => ({ f, key: `brand/${path.relative(path.join(root, "brand"), f).split(path.sep).join("/")}` })),
  ].filter(({ key }) => /\.(webp|png|jpe?g|gif|svg)$/i.test(key));

  if (!files.length) {
    logger.warn(`No images found under ${root}. Set SEED_ASSETS_DIR in .env to the client-site public/assets folder.`);
    return;
  }
  const col = mongoose.connection.db.collection("media.files");
  let up = 0;
  for (const { f, key } of files) {
    if (!FORCE_MEDIA && (await col.findOne({ filename: key }, { projection: { _id: 1 } }))) continue;
    const buf = await fs.readFile(f);
    await putFile(key, buf, contentTypeFor(key), { kind: "image", seeded: true });
    up++;
  }
  logger.info(`Media: ${up} uploaded, ${files.length - up} already in database (${files.length} total)`);
}

/* ───────── 2. catalog ───────── */
const SKU = {
  "pukhraj-yellow-sapphire": ["GEM-PUK-YS", 3, 23],
  "panna-emerald": ["GEM-PAN-EM", 3, 11],
  "moonga-red-coral-mala": ["GEM-MNG-54", 3, 37],
  "moti-pearl-mala": ["GEM-MOT-18", 3, 19],
  "nepali-rudraksha-japa-mala": ["MAL-RUD-NP108", 12, 286],
  "sphatik-crystal-mala": ["MAL-SPH-108", 12, 164],
  "shri-yantra-copper-plate": ["YNT-SRI-CP6", 12, 92],
  "laddu-gopal-murti": ["MRT-LDG-05", 12, 143],
  "laddu-gopal-poshak-set": ["MRT-PSK-03", 5, 118],
  "copper-puja-lota": ["PUJ-LOT-CU5", 12, 77],
  "brass-akhand-jyoti": ["PUJ-AKJ-09", 12, 58],
  "shankha-pola-set": ["PUJ-SHK-PL2", 3, 49],
  "braj-chandan-agarbatti": ["DHP-CHN-100", 5, 731],
  "mor-pankh-set": ["MRT-MOR-05", 5, 102],
  "brihat-jyotish-guide": ["BK-JYO-BRH", 0, 64],
  "mathura-peda-prasad": ["PRS-PDA-500", 5, 211],
};
const CHADHAVA_LIMITS = { poshak: 150, "phool-bangla": 100, "peda-bhog": 400, "tulsi-mala": 500, "laal-saree": 150, "jaba-mala": 600, "shankha-pola": 200, "mishti-bhog": 300, "sarson-tel": 800, "kala-til": 800, aparajita: 500, "til-deep": 800, chola: 250, "laddoo-bhog": 400, nariyal: 400 };

async function seedCatalog() {
  await upsertMany(Temple, data.temples.map((t, i) => ({ ...t, active: true, order: i })), "slug");
  const temples = new Map((await Temple.find({}, { slug: 1 }).lean()).map((t) => [t.slug, t._id]));

  await upsertMany(AddOn, data.addOns.map((a, i) => ({ key: a.id, name: a.name, price: a.price, desc: a.desc, image: a.image, active: true, order: i })), "key");

  const boxContents = "Prasad, raksha sutra, temple kumkum, blessed deity photo";
  await upsertMany(
    Puja,
    data.pujas.map((p) => ({
      slug: p.slug,
      title: p.title,
      subtitle: p.subtitle,
      ribbon: p.ribbon ?? "",
      deity: p.deity,
      purposes: p.purposes,
      temple: temples.get(p.templeSlug),
      date: rel(p.date),
      cutoff: rel(p.cutoff),
      tithi: p.tithi,
      images: p.images,
      devotees: p.devotees,
      featured: !!p.featured,
      status: "Published",
      about: p.about,
      benefits: p.benefits,
      process: p.process,
      faqs: p.faqs?.length ? p.faqs : [{ q: "When will I receive the video?", a: "Within 2–4 days of the puja on WhatsApp." }],
      packages: p.packages.map((k) => ({ key: k.id, name: k.name, persons: k.persons, price: k.price, strike: k.strike, popular: !!k.popular, desc: k.desc })),
      addOns: p.addOns,
      boxContents,
      seo: { title: `${p.title} — Book Online`, desc: `${p.subtitle}. Book in your name & gotra.` },
    })),
    "slug",
  );

  await upsertMany(
    Chadhava,
    data.chadhavas.map((c) => ({
      slug: c.slug,
      title: c.title,
      subtitle: c.subtitle,
      temple: temples.get(c.templeSlug),
      date: rel(c.date),
      cutoff: new Date(rel(c.date).getTime() - 6 * 3_600_000),
      tithi: c.tithi,
      image: c.image,
      about: c.about,
      devotees: c.devotees,
      status: "Published",
      items: c.items.map((i) => ({ key: i.id, name: i.name, price: i.price, image: i.image, desc: i.desc, limit: CHADHAVA_LIMITS[i.id] ?? 0, sold: 0 })),
    })),
    "slug",
  );

  await upsertMany(Category, data.categories.map((c, i) => ({ ...c, order: i, active: true })), "slug");
  await upsertMany(Category, [{ slug: "navratna", name: "Navratna & Upratna", parent: "gemstones", icon: "Gem", image: "/media/product/red-coral.webp", order: 99, active: true }], "slug");

  await upsertMany(
    Product,
    data.products.map((p) => {
      const [sku, gst, sold] = SKU[p.slug] ?? [p.slug.toUpperCase().slice(0, 20), 12, 0];
      return { ...p, sku, gst, sold, lowStock: 10, status: "Active", badge: p.badge ?? "", howToUse: p.howToUse ?? "", bestseller: !!p.bestseller, specs: p.specs };
    }),
    "slug",
  );
}

/* ───────── 3. content & marketing ───────── */
async function seedContent() {
  const h = data.home;
  const banners = [
    ...h.heroSlides.map((s, i) => ({ title: s.caption, subtitle: "Hero background", image: s.image, link: "/puja", placement: "Home hero", active: true, order: i + 1 })),
    ...h.promos.map((p, i) => ({ title: p.title, subtitle: p.subtitle, tagline: p.tagline ?? "", pujaSlug: p.pujaSlug ?? "", image: p.image, link: p.link, placement: "Home promo", active: true, order: i + 1 })),
    { title: "Shyama Kali Puja at Kalighat", subtitle: "Few sankalp slots left", image: "/media/puja/kali-homa.webp", link: "/puja/kalighat-shyama-kali-puja", placement: "Puja listing", active: true, order: 1 },
    { title: "Lab-certified gemstones", subtitle: "Pukhraj, Panna, Moonga and Moti — checked by our astrologers before dispatch.", tagline: "Ratna for your graha", image: "/media/product/yellow-sapphire.webp", link: "/store/category/gemstones", placement: "Store", active: true, order: 1 },
  ];
  if (FRESH || !(await Banner.estimatedDocumentCount())) {
    await Banner.insertMany(banners);
    logger.info(`Banner: ${banners.length} inserted`);
  } else logger.info("Banner: already present");

  const { heroSlides: _slides, promos: _promos, ...homeConfig } = h; // banners live in their own collection
  await Setting.updateOne({ key: "home" }, { $setOnInsert: { key: "home", value: homeConfig } }, { upsert: true });
  await Setting.updateOne({ key: "site" }, { $setOnInsert: { key: "site", value: DEFAULT_SITE } }, { upsert: true });
  logger.info("Settings: home & site ensured");

  const faqs = [
    ...data.globalFaqs.map((f, i) => ({ q: f.q, a: f.a, group: i === 6 ? "Refunds" : "Puja", order: i })),
    { q: "How soon will my order arrive?", a: "We pack and dispatch within 2 working days. Most orders reach you in 5–7 days anywhere in India.", group: "Store", order: 20 },
    { q: "Do you offer cash on delivery?", a: "Yes, COD is available on most pincodes for a small handling fee. Prepaid orders above ₹599 are shipped free.", group: "Store", order: 21 },
    { q: "Are your gemstones certified?", a: "Every Pukhraj and Panna ships with a gem-testing lab report. Please consult an astrologer before wearing a gemstone.", group: "Store", order: 22 },
  ];
  if (FRESH || !(await Faq.estimatedDocumentCount())) {
    await Faq.insertMany(faqs);
    logger.info(`Faq: ${faqs.length} inserted`);
  } else logger.info("Faq: already present");

  const pageBody = (title) => `# ${title}\n\nThis page is managed from Admin → Content. Replace this text with your final ${title.toLowerCase()}.`;
  await upsertMany(
    Page,
    [
      ["about", "About us"],
      ["privacy", "Privacy policy"],
      ["terms", "Terms of use"],
      ["refund", "Refund policy"],
      ["shipping", "Shipping policy"],
    ].map(([slug, title]) => ({ slug, title, body: pageBody(title), updatedBy: "Seed" })),
    "slug",
  );

  await upsertMany(
    Post,
    [
      { slug: "what-is-kaal-sarp-dosh", title: "What is Kaal Sarp Dosh and how is it pacified?", category: "Jyotish", status: "Published", image: "/media/puja/navagraha.webp", publishAt: new Date(NOW - 3 * DAY), excerpt: "How Rahu and Ketu form this yoga, and why Trimbakeshwar is chosen for its shanti." },
      { slug: "why-bengal-worships-kali-on-deepavali", title: "Why does Bengal worship Maa Kali on Deepavali night?", category: "Festivals", status: "Published", image: "/media/puja/kali-homa.webp", publishAt: new Date(NOW - 8 * DAY), excerpt: "The story behind Shyama Puja and the lamps lit for the Divine Mother." },
      { slug: "choosing-a-gemstone-for-your-kundli", title: "Choosing a gemstone for your kundli: a simple guide", category: "Jyotish", status: "Draft", image: "/media/product/emerald.webp" },
      { slug: "caring-for-laddu-gopal-at-home", title: "Caring for Laddu Gopal at home: daily seva made easy", category: "Guides", status: "Scheduled", image: "/media/puja/laddu-gopal.webp", publishAt: new Date(NOW + 4 * DAY) },
    ],
    "slug",
  );

  await upsertMany(
    Coupon,
    [
      { code: "RADHE11", type: "Percent", value: 11, minOrder: 501, appliesTo: "Puja", limit: 1000, perUser: 2, expires: new Date(NOW + 25 * DAY), active: true },
      { code: "DEEPAVALI201", type: "Flat", value: 201, minOrder: 1499, appliesTo: "Store", limit: 500, perUser: 1, expires: new Date(NOW + 15 * DAY), active: true },
      { code: "PEHLISEVA", type: "Percent", value: 12, maxDiscount: 250, minOrder: 0, appliesTo: "All", limit: 5000, perUser: 1, expires: new Date(NOW + 120 * DAY), active: true },
      { code: "SHARAD51", type: "Flat", value: 51, minOrder: 351, appliesTo: "Puja", limit: 300, expires: new Date(NOW - 2 * DAY), active: false },
    ],
    "code",
  );

  // BRD §6.13: demo reviews only outside production, always flagged isDemo (hidden in production)
  if (!env.isProd && (FRESH || !(await Review.countDocuments({ isDemo: true })))) {
    const p = await Puja.findOne({ slug: "kalighat-shyama-kali-puja" }, { _id: 1, title: 1, slug: 1 }).lean();
    await Review.insertMany(
      data.demoReviews.map((r, i) => ({ customerName: r.name, city: r.city, rating: r.rating, text: r.text, kind: i === 3 ? "Product" : "Puja", target: i === 3 ? "Nepali Rudraksha Japa Mala" : p?.title, targetId: i === 3 ? undefined : p?._id, targetSlug: p?.slug, status: "Approved", featured: i < 2, isDemo: true })),
    );
    logger.info(`Review: ${data.demoReviews.length} demo reviews inserted (isDemo, hidden in production)`);
  }
}

/* ───────── 4. first admin ───────── */
async function seedAdmin() {
  if (await Admin.exists({ email: env.SEED_ADMIN_EMAIL })) return logger.info(`Admin: ${env.SEED_ADMIN_EMAIL} already exists`);
  if (!env.SEED_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD.length < 8) return logger.warn("Admin: set SEED_ADMIN_PASSWORD (8+ chars) in .env to create the first super admin");
  await Admin.create({ email: env.SEED_ADMIN_EMAIL, name: env.SEED_ADMIN_NAME, role: "super_admin", passwordHash: await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12) });
  logger.info(`Admin: created super admin ${env.SEED_ADMIN_EMAIL}`);
}

/* ───────── run ───────── */
async function main() {
  await connectDB({ retries: 3 });
  if (FRESH) {
    logger.warn("--fresh: clearing catalog & content collections (users, bookings, orders and payments are kept)");
    for (const M of [Temple, AddOn, Puja, Chadhava, Category, Product, Banner, Faq, Page, Post, Coupon]) await M.deleteMany({});
    await Review.deleteMany({ isDemo: true });
    await Setting.deleteMany({ key: { $in: ["home", "site"] } });
  }
  // build indexes before inserting so unique keys are enforced
  await Promise.all([Temple, AddOn, Puja, Chadhava, Category, Product, Coupon, Page, Post, Setting, Admin].map((M) => M.init()));
  await seedMedia();
  await seedCatalog();
  await seedContent();
  await seedAdmin();
  logger.info("✔ Seed complete");
}

main()
  .catch((err) => {
    logger.error({ err }, "Seed failed");
    process.exitCode = 1;
  })
  .finally(() => disconnectDB());
