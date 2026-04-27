const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Smart Formatter for International Numbers (Twilio requirement)
const formatPhone = (phone) => {
  if (!phone) return "";
  let cleaned = phone.toString().replace(/\s/g, '').replace(/-/g, '');
  if (cleaned.length === 10) return `+91${cleaned}`; // Default to India for 10-digit numbers
  if (!cleaned.startsWith('+')) return `+${cleaned}`;
  return cleaned;
};

// Mock Data for High Risk Zones (New Delhi, India)
const mockHighRiskZones = [
  { lat: 28.6139, lng: 77.2090, radius: 400, reason: 'Poor Lighting' },
  { lat: 28.6250, lng: 77.2150, radius: 300, reason: 'Recent Reports' },
  { lat: 28.6000, lng: 77.2200, radius: 500, reason: 'Isolated Street' }
];

app.get('/', (req, res) => {
  res.status(200).json({ status: 'online', service: 'Sentinel AI Backend', version: '1.0.0' });
});

// Health check for cloud services
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// File-based persistent store for user contacts (survives server restarts)
const CONTACTS_FILE = path.join(__dirname, 'contacts_store.json');

const loadContacts = () => {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading contacts:', e.message); }
  return {};
};

const saveContacts = (store) => {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(store, null, 2));
  } catch (e) { console.error('Error saving contacts:', e.message); }
};

let userContactsStore = loadContacts();
console.log('[STARTUP] Loaded contacts for users:', Object.keys(userContactsStore));

// Endpoint to get high-risk zones (Safety Heatmap data)
app.get('/api/risk-zones', (req, res) => {
  res.json({ zones: mockHighRiskZones });
});

// Debug endpoint to verify config (remove in production)
app.get('/api/debug', (req, res) => {
  res.json({
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
    twilioPhone: process.env.TWILIO_PHONE_NUMBER || 'NOT SET',
    storedUsers: Object.keys(loadContacts()),
    contacts: loadContacts()
  });
});

// Endpoint for Emergency SOS
app.post('/api/emergency', async (req, res) => {
  let { location, timestamp, user, contacts } = req.body;
  const userName = user || 'App User';
  const userKey = user || 'default';

  // 1. If contacts are provided, SAVE them persistently for this user
  if (contacts && contacts.length > 0) {
    userContactsStore[userKey] = contacts;
    saveContacts(userContactsStore);
    console.log(`[BACKEND] Saved ${contacts.length} contacts for ${userKey}`);
  } 
  // 2. If contacts are NOT provided (e.g. from native shake), use the SAVED ones
  else {
    userContactsStore = loadContacts(); // reload fresh from file
    contacts = userContactsStore[userKey] || [];
    if (contacts.length > 0) {
      console.log(`[BACKEND] Using ${contacts.length} saved contacts for ${userKey}`);
    }
  }

  console.log(`\n[EMERGENCY SOS] Triggered by ${userName} at ${location?.lat}, ${location?.lng}`);
  
  if (contacts && contacts.length > 0) {
    console.log(`[ALERTING CONTACTS] Sending SMS and Automated Call to ${contacts.length} people...`);
    
    // The SMS message we will send
    const mapLink = `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;
    const messageBody = `Sentinel AI SOS: ${userName} needs help. Live location: ${mapLink}`;

    // The Voice Message (TwiML) to read out loud on the call
    const twiml = `<Response><Say voice="alice" language="en-IN">Emergency Alert! ${userName} has activated the Sentinel SOS. They may be in immediate danger. Please check your SMS immediately for their live GPS location. I repeat, this is an emergency alert.</Say></Response>`;

    for (const c of contacts) {
      const formattedTo = formatPhone(c.phone);
      if (twilioClient && process.env.TWILIO_PHONE_NUMBER) {
        // 1. Send the SMS
        try {
          const message = await twilioClient.messages.create({
            body: messageBody,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: formattedTo
          });
          console.log(`  ✅ SMS successfully sent to ${c.name} (${formattedTo})`);
        } catch (error) {
          console.error(`  ❌ Failed to send SMS to ${c.name} (${formattedTo}): ${error.message}`);
        }

        // 2. Initiate the Voice Call
        try {
          await twilioClient.calls.create({
            twiml: twiml,
            to: formattedTo,
            from: process.env.TWILIO_PHONE_NUMBER
          });
          console.log(`  📞 Automated Call initiated to ${c.name} (${formattedTo})`);
        } catch (error) {
          console.error(`  ❌ Failed to call ${c.name} (${formattedTo}): ${error.message}`);
        }
      } else {
        // Fallback log if Twilio isn't set up yet
        console.log(`  -> (SIMULATED SMS) to ${c.name} (${formattedTo}): ${messageBody}`);
      }
    }
  } else {
    console.log(`[ALERTING] No trusted contacts found for ${userKey}. Please add them in the app first!`);
  }
  
  res.json({ success: true, message: 'Emergency alerts dispatched.', contactsCount: contacts?.length || 0 });
});

// ─── Sentinel AI Safety Assistant ────────────────────────────────────────────
const safetyKB = [
  // EMERGENCY
  { pattern: /\b(sos|emergency|help me|i('m| am) in danger|attack|attacked|assault|assaulted|kidnap|kidnapped|rape|raped|someone following me|being followed|chased|mugged|robbery|robber|stabbed|shot|threatening me)\b/i,
    response: `🚨 **EMERGENCY DETECTED** — Stay calm. Do these right now:\n\n1. **Press the SOS button** on the Emergency tab immediately — it will alert your trusted contacts with your live location.\n2. **Call 112** (India Emergency) or **100** (Police) right now.\n3. Move toward a **crowded, well-lit place** — a shop, petrol station, or restaurant.\n4. If being followed, **enter any open business** and tell the staff.\n5. Keep your phone charged and visible.\n\nI am standing by. Are you physically safe right now?` },

  // POLICE
  { pattern: /\bpolice\b|\bcop\b|\blaw enforcement\b|\bauthorities\b/i,
    response: `📞 **Indian Emergency Numbers:**\n\n• **100** — Police\n• **112** — Universal Emergency (works on any network, even without balance)\n• **1091** — Women's Helpline\n• **1096** — Anti-Stalking Helpline\n\nTell the operator:\n• Your **exact location** (nearest landmark)\n• **What happened** briefly\n• **Your name** and phone number\n\nShall I also alert your trusted contacts right now?` },

  // AMBULANCE / MEDICAL
  { pattern: /\b(ambulance|medical|injured|hurt|bleeding|accident|hospital|doctor|unconscious|fainted)\b/i,
    response: `🏥 **Medical Emergency:**\n\n• Call **108** — Free Ambulance (India)\n• Call **112** — Universal Emergency\n• **AIIMS Emergency:** 011-26589900\n\nWhile waiting:\n• Do not move the injured person unless they are in danger\n• Apply pressure to any bleeding wounds\n• Keep them warm and conscious by talking to them\n\nDo you need me to alert your trusted contacts too?` },

  // FIRE
  { pattern: /\b(fire|smoke|burning|flame|blaze)\b/i,
    response: `🔥 **Fire Emergency:**\n\n• Call **101** — Fire Brigade\n• Call **112** — Universal Emergency\n\nImmediate actions:\n• **Evacuate immediately** — do not use elevators\n• Stay **low to the ground** if there is smoke\n• Feel doors before opening — if hot, do NOT open\n• Go to your pre-decided **assembly point**\n• Never go back inside for belongings\n\nAre you safely out of the building?` },

  // STALKING / BEING FOLLOWED
  { pattern: /\b(stalker|stalking|following me|being followed|suspicious person|creepy|watching me)\b/i,
    response: `👁️ **If You Are Being Followed:**\n\n1. **Do not go home** — you don't want them to know where you live.\n2. Enter a **busy public place** immediately — a mall, restaurant, police station.\n3. Call someone and **speak loudly** about your location.\n4. Call **1096** — Anti-Stalking Helpline\n5. Note their **description**: clothing, height, any vehicle number.\n\nUse our **Safe Route** feature to navigate to the nearest police station. Do you want me to alert your trusted contacts?` },

  // SAFE ROUTE / NAVIGATION
  { pattern: /\b(safe route|safe path|safe way|navigate|navigation|directions|how to reach|route)\b/i,
    response: `🗺️ **Safe Route Navigation:**\n\nUse the **Navigate tab** in the app to:\n• Get the safest walking or driving route\n• See **real-time crime zones** highlighted in red along your path\n• Track police stations and hospitals nearby\n• Get a **Safety Score** for your route\n• Your live location updates as you move\n\nTips for safe travel:\n• **Avoid** isolated streets, underpasses, and poorly-lit areas at night\n• **Share your route** with a trusted contact before starting\n• Stay on **main roads** with good lighting and traffic\n\nWould you like safety tips for a specific time or area?` },

  // NIGHT SAFETY
  { pattern: /\b(night|dark|late|midnight|2am|3am|1am|12am|alone at night|travelling at night|walking at night)\b/i,
    response: `🌙 **Night Safety Tips:**\n\n• **Share your live location** with a trusted contact before stepping out\n• Stick to **well-lit, busy streets** even if it takes longer\n• Keep your **phone charged** and volume on\n• Walk **confidently** and stay aware — avoid headphones\n• **Avoid shortcuts** through parks, lanes, or isolated areas\n• Use our **Safe Route** to get the safest path\n• Keep **112** on speed dial\n• If taking an auto/cab — share the vehicle number with a contact\n\nIs there a specific situation I can help with?` },

  // CAB / AUTO SAFETY
  { pattern: /\b(cab|taxi|auto|ola|uber|rapido|driver|vehicle|car ride)\b/i,
    response: `🚕 **Safe Cab / Auto Tips:**\n\n• **Share the trip details** (vehicle number, driver name) with a trusted contact\n• Use the app's **Share Live Location** feature during your ride\n• Sit in the **back seat**, not front\n• Verify the **vehicle number plate** matches what the app shows\n• Do not share personal info with the driver\n• If uncomfortable — **call someone and speak your location aloud**\n• Trust your instincts — it's okay to cancel a ride that feels wrong\n• In emergency, **call 112** or use our SOS button\n\nShall I start sharing your live location with your contacts?` },

  // HARASSMENT
  { pattern: /\b(harass|harassment|eve teas|catcall|groping|molest|molestation|touching|uncomfortable)\b/i,
    response: `🛡️ **If You Are Being Harassed:**\n\n1. **Speak loudly** — "Stop it!" draws public attention\n2. **Move toward other people** — do not isolate yourself\n3. **Record if safe** — video/audio is strong evidence\n4. Report to **1091** (Women's Helpline) or **100** (Police)\n5. **Document everything**: time, location, description of person\n\nYou have every right to your safety. If harassment continues or escalates to assault, use our **SOS button** immediately.\n\nWould you like me to find the nearest police station from your current location?` },

  // TRUSTED CONTACTS
  { pattern: /\b(trusted contact|emergency contact|add contact|share location|alert family|notify contact)\b/i,
    response: `👥 **Trusted Contacts:**\n\nIn the **Contacts tab** you can:\n• Add family or friends as trusted contacts\n• They will be **automatically alerted** with your live location when you press SOS\n• You can send a **manual check-in** anytime\n\nRecommendation: Add at least **2 contacts** — one family member and one friend.\n\nYour contacts receive a Google Maps link with your exact location the moment SOS is activated. Shall I guide you to the Contacts tab?` },

  // SELF DEFENCE
  { pattern: /\b(self.?def[ea]n[cs]e|self.?protect|how to fight|how to escape|attack back|pepper spray)\b/i,
    response: `🥊 **Personal Safety & Self-Defence:**\n\n• **Run first** — the best defence is escape\n• **Scream loudly** — draws attention, deters attackers\n• **Strike vulnerable areas** if grabbed: eyes, nose, throat, groin, knees\n• **Pepper spray** is legal in India and highly effective — keep one accessible\n• Go for **self-defence classes**: many are free/low-cost for women\n• The **elbow** is your strongest striking tool at close range\n\nMost importantly: **No possession is worth your life** — give up your bag, phone, or wallet. They can be replaced.\n\nIs there a specific situation you want advice for?` },

  // UNSAFE AREA / CRIME
  { pattern: /\b(unsafe area|crime|high crime|dangerous area|avoid area|crime zone|crime rate)\b/i,
    response: `⚠️ **Identifying & Avoiding Unsafe Areas:**\n\nOur app shows **real-time crime zones** (marked in red) on the map. These are based on:\n• Police reports and FIR data\n• Community incident reports\n• Areas with poor lighting, low foot traffic\n\n**Avoid areas that have:**\n• Poor street lighting\n• Low foot traffic (especially at night)\n• History of theft, harassment, or violence\n\nUse the **Navigate tab** to automatically route around known danger zones. The system assigns a **Safety Score** to every route.\n\nWould you like safety tips for a specific area or time?` },

  // WHAT CAN YOU DO
  { pattern: /\b(what can you do|how can you help|features|capabilities|what do you do|help me with)\b/i,
    response: `🌟 **I am your Sentinel AI Safety Assistant. Here's how I help:**\n\n🗺️ **Safe Navigation** — Find the safest route avoiding crime zones\n🚨 **Emergency SOS** — Instantly alert contacts with live location\n👥 **Trusted Contacts** — Family/friends who are notified in emergencies\n🏥 **Emergency Numbers** — Quick access to police, ambulance, helplines\n🛡️ **Safety Advice** — Tips for travel, night walks, cabs, harassment\n📍 **Live Location** — Share your position with loved ones\n⚠️ **Crime Zones** — See real danger areas on the map\n\nJust ask me anything related to your safety — I'm here 24/7.` },

  // PHONE SNATCHED / THEFT
  { pattern: /\b(phone snatch|phone stolen|bag stolen|wallet stolen|pickpocket|robbery|robbed|theft|stolen)\b/i,
    response: `📱 **If Your Phone or Belongings Are Stolen:**\n\n**Immediately:**\n1. Call **100** (Police) from any phone\n2. File an **FIR** at the nearest police station — essential for insurance\n3. Block your SIM by calling your carrier's helpline (Jio: 198, Airtel: 121, Vi: 199)\n4. Use **Find My Device** (Google/Apple) from another device to locate/lock/erase\n5. Block your **bank cards** via your banking app or call the bank\n\n**For Phone Theft FIR:**\nNote down your IMEI number (check old phone bills or Google account) — police can track it.\n\nAre you safe right now?` },

  // HELLO / GREETINGS
  { pattern: /\b(hello|hi|hey|good morning|good evening|good afternoon|namaste|hii|helo)\b/i,
    response: `👋 **Hello! I'm your Sentinel AI Safety Assistant.**\n\nI'm here 24/7 to help you with:\n• 🚨 Emergency guidance and SOS activation\n• 🗺️ Safe route navigation in your area\n• 🛡️ Personal safety tips\n• 📞 Emergency helpline numbers\n• 🚕 Cab and travel safety\n• 🌙 Night-time safety advice\n\nHow can I help keep you safe today?` },

  // THANK YOU
  { pattern: /\b(thank|thanks|thank you|thankyou|thx)\b/i,
    response: `You're welcome. 🛡️ Your safety is our top priority.\n\nRemember:\n• Keep **SOS** easily accessible in emergencies\n• Add your **trusted contacts** in the Contacts tab\n• Use **Safe Route** whenever you travel\n\nStay safe. I'm here whenever you need me. 💙` },

  // ARE YOU OKAY / CHECK IN
  { pattern: /\b(are you there|you there|still there|check.?in|i am safe|i'm safe|i am okay|i'm okay)\b/i,
    response: `✅ I'm right here, always monitoring for your safety.\n\nGlad you're safe! A few quick tips:\n• Do a **location check-in** with your contacts when you reach your destination\n• Use the **Safe Route** feature for your next journey\n• Keep your phone charged above 30% when out\n\nIs there anything else I can help you with?` },

  // WOMEN SAFETY
  { pattern: /\b(women safety|woman safety|female safety|girl safety|ladies|safe for women)\b/i,
    response: `👩 **Women's Safety Resources (India):**\n\n📞 **Helplines:**\n• **1091** — Women's Helpline (24/7)\n• **181** — Mahila Helpline\n• **1096** — Anti-Stalking\n• **112** — Universal Emergency\n• **7827170170** — iCall (psychological support)\n\n🛡️ **Key Tips:**\n• Trust your instincts — if something feels wrong, it probably is\n• Use **Sentinel's SOS** button to alert contacts instantly\n• The app tracks your location in real-time during navigation\n• **Nirbhaya Fund** apps and women-only cab options are available\n\nWhich specific situation can I help you with?` },

  // DEFAULT
];

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.json({ response: "I didn't catch that. Please ask me anything about your safety." });
  }

  let response = null;
  for (const entry of safetyKB) {
    if (entry.pattern.test(message)) {
      response = entry.response;
      break;
    }
  }

  if (!response) {
    // Smart fallback based on message length/content
    const isQuestion = message.includes('?');
    response = isQuestion
      ? `I want to make sure I give you the best help. Could you tell me more? For example:\n\n• Are you in **immediate danger**? → Say "emergency" or press the SOS button\n• Need a **safe route**? → Go to the Navigate tab\n• Looking for **safety tips**? → Ask me about night safety, cab safety, harassment, etc.\n• Need **emergency numbers**? → Ask me for police, ambulance, or helpline contacts\n\nI'm here for you. 🛡️`
      : `I'm your personal safety assistant, ready to help 24/7.\n\nHere's what I can help with:\n• 🚨 **Emergency guidance** — type "emergency" or "SOS"\n• 🗺️ **Safe routes** — type "safe route"\n• 📞 **Helplines** — type "police" or "ambulance"\n• 🌙 **Safety tips** — type "night safety" or "cab safety"\n• 👩 **Women's safety** — type "women safety"\n\nWhat do you need help with today?`;
  }

  setTimeout(() => res.json({ response }), 400);
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
