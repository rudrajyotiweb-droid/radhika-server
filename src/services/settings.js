import { Setting } from "../models/index.js";
import { logger } from "../utils/logger.js";

/** Defaults mirror client-site/src/data/site.ts and the admin Settings screen. */
export const DEFAULT_SITE = {
  brand: {
    name: "Radhika Astro",
    tagline: "Divine Grace, Vedic Insight",
    description:
      "Book pujas at sacred temples of India in your name and gotra, receive the puja video on WhatsApp and get the Aashirwad Box at your doorstep. Shop authentic gemstones, malas and puja essentials.",
    phone: "+91 90000 00000",
    whatsapp: "919000000000",
    email: "seva@radhikaastro.example",
    supportHours: "8 AM – 9 PM IST, all days",
    address: "12 Temple Road, Kolkata, West Bengal 700001",
    logo: "/media/brand/emblem.png",
    wordmark: "/media/brand/logo-full.webp",
  },
  stats: { pujas: 850, devotees: 12000, temples: 18, rating: 4.9 },
  tax: { gstin: "19ABCDE1234F1Z5", legalName: "Radhika Astro Seva Pvt. Ltd.", pujaGst: 18, invoicePrefix: "RA/26-27/" },
  shipping: { freeShippingThreshold: 599, standardFee: 59, expressFee: 119, codEnabled: true, codFee: 59, pickupLocation: "Kolkata Warehouse" },
  notifications: { booking_confirmed: true, mantra_reminder: true, puja_video_ready: true, box_dispatched: true, order_shipped: true },
  /** Header / decorative images of the website's fixed pages (Admin → Settings → Website images). */
  pageImages: {
    heroDeity: "/media/deity/vishnu.webp",
    puja: "/media/puja/radha-krishna.webp",
    chadhava: "/media/chadhava/phool-bangla.webp",
    temples: "/media/temple/mayapur.webp",
    store: "/media/product/yantra.webp",
    contact: "/media/temple/kalighat.webp",
    faq: "/media/puja/satyanarayan.webp",
    howItWorks: "/media/temple/banke-bihari.webp",
    about: "/media/hero/prem-mandir.webp",
    aboutStory: "/media/hero/yamuna-ghat.webp",
    login: "/media/hero/mayapur-dusk.webp",
    policy: "/media/temple/barsana.webp",
    appInstall: "/media/hero/diya-rangoli.webp",
  },
  /** "How Puja Seva Works" steps (home/puja/chadhava strip and the How it works page). */
  howItWorks: [
    { title: "Choose your puja", desc: "Pick a puja or chadhava at a sacred temple and select the package that suits your family.", icon: "Flower2", image: "/media/puja/radha-krishna.webp", points: ["Pujas at Braj dhams, Shakti Peethas & Jyotirlingas", "Clear packages for 1 to 6 people"] },
    { title: "Share name & gotra", desc: "Fill in the names and gotra for the sankalp. Not sure of your gotra? We follow the shastra and use Kashyap.", icon: "ScrollText", image: "/media/puja/yagna.webp", points: ["Pick saved family members in one tap", "Kashyap gotra used when unknown"] },
    { title: "Watch your puja", desc: "Temple pandits perform the rituals in your name. The puja video reaches your WhatsApp within 2–4 days.", icon: "Video", image: "/media/hero/yamuna-ghat.webp", points: ["Performed by temple pandits", "Video on WhatsApp within 2–4 days"] },
    { title: "Receive Aashirwad", desc: "A blessed Aashirwad Box with prasad and sacred items arrives at your doorstep in 8–10 days.", icon: "Gift", image: "/media/chadhava/peda.webp", points: ["Prasad, raksha sutra & blessed items", "Delivered across India in 8–10 days"] },
  ],
};

const cache = new Map(); // key → { value, at }
const TTL = 30_000;

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  return out;
}

export async function getSetting(key, fallback = {}) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const doc = await Setting.findOne({ key }).lean();
    const value = merge(fallback, doc?.value ?? {});
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    logger.error({ err, key }, "Failed to read setting, using defaults");
    return hit?.value ?? fallback;
  }
}

export async function setSetting(key, value) {
  const doc = await Setting.findOneAndUpdate({ key }, { $set: { value } }, { upsert: true, new: true, lean: true });
  cache.delete(key);
  return doc.value;
}

export const getSite = () => getSetting("site", DEFAULT_SITE);
export const getHome = () => getSetting("home", {});
