const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'az-poc-secret-change-in-prod';
const MOCK_OTP = process.env.MOCK_OTP || '111111';

app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Logging ──────────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─── In-memory state ──────────────────────────────────────────────────────────

// Agents: phone → agent object
const agents = {
  '+919999999999': { id: 'ag_01', name: 'Ravi K.', phone: '+919999999999', fcm_token: null },
  '+919876543210': { id: 'ag_02', name: 'Suresh M.', phone: '+919876543210', fcm_token: null },
};

// Location cache: agent_id → { lat, lng, bearing, accuracy, reported_at }
const locationCache = {};

// Orders: order_id → order object (mutable — status transitions happen here)
const orders = {
  'FOC-2026-05-12-0041': {
    order_id: 'FOC-2026-05-12-0041',
    assigned_agent_id: 'ag_01',
    order_status: 'assigned',
    patient_name: 'Meera T.',
    patient_phone: '+919812345678',
    delivery_address: { full: 'Plot 7, 2nd Cross, Koramangala 5th Block, Bangalore 560095', lat: 12.9352, lng: 77.6245 },
    delivery_area: 'Koramangala',
    items: [{ name: 'Metformin 500 mg', quantity: 60 }, { name: 'Glimepiride 2 mg', quantity: 30 }],
    distance_km: 3.4,
    stage_dates: { placed: { date: '12 May', time: '09:30' }, dispensed: { date: '12 May', time: '10:45' } },
    assigned_at: '2026-05-12T11:00:00+05:30',
    out_for_delivery_at: null,
    delivered_at: null,
    proof_photo_url: null,
  },
  'FOC-2026-05-12-0042': {
    order_id: 'FOC-2026-05-12-0042',
    assigned_agent_id: 'ag_01',
    order_status: 'out_for_delivery',
    patient_name: 'Anita S.',
    patient_phone: '+919876500001',
    delivery_address: { full: 'Flat 4B, 12th Main, Indiranagar, Bangalore 560038', lat: 12.9279, lng: 77.6271 },
    delivery_area: 'Indiranagar',
    items: [{ name: 'Metformin 500 mg', quantity: 30 }, { name: 'Atorvastatin 10 mg', quantity: 30 }, { name: 'Telmisartan 40 mg', quantity: 30 }],
    distance_km: 2.1,
    stage_dates: {
      placed: { date: '12 May', time: '10:14' },
      dispensed: { date: '12 May', time: '11:02' },
      out_for_delivery: { date: '12 May', time: '16:08' },
    },
    assigned_at: '2026-05-12T15:30:00+05:30',
    out_for_delivery_at: '2026-05-12T16:08:00+05:30',
    delivered_at: null,
    proof_photo_url: null,
  },
  'FOC-2026-05-12-0039': {
    order_id: 'FOC-2026-05-12-0039',
    assigned_agent_id: 'ag_01',
    order_status: 'delivered',
    patient_name: 'Pranav R.',
    patient_phone: '+919898765432',
    delivery_address: { full: '12, 27th Main, HSR Layout Sector 2, Bangalore 560102', lat: 12.9116, lng: 77.6389 },
    delivery_area: 'HSR Layout',
    items: [{ name: 'Amlodipine 5 mg', quantity: 30 }, { name: 'Losartan 50 mg', quantity: 30 }],
    distance_km: 5.7,
    stage_dates: {
      placed: { date: '12 May', time: '08:00' },
      dispensed: { date: '12 May', time: '09:15' },
      out_for_delivery: { date: '12 May', time: '14:20' },
      delivered: { date: '12 May', time: '15:42' },
    },
    assigned_at: '2026-05-12T13:00:00+05:30',
    out_for_delivery_at: '2026-05-12T14:20:00+05:30',
    delivered_at: '2026-05-12T15:42:00+05:30',
    proof_photo_url: 'https://picsum.photos/seed/proof1/400/300',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }

function nowLabel() {
  const now = new Date();
  const date = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return { date, time };
}

function issueToken(agent) {
  return jwt.sign(
    { sub: agent.id, role: 'agent', phone: agent.phone },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Haversine distance in km
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeETA(agentLat, agentLng, destLat, destLng) {
  const distKm = haversine(agentLat, agentLng, destLat, destLng);
  const avgSpeedKmh = 20;
  const minutes = Math.max(1, Math.round((distKm / avgSpeedKmh) * 60));
  const arrivesAt = new Date(Date.now() + minutes * 60 * 1000);
  return {
    minutes,
    arrives_at: arrivesAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
    computed_at: nowISO(),
  };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAgentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'agent') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    req.agentId = payload.sub;
    req.agentPhone = payload.phone;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ─── POST /agent/auth/send-otp ────────────────────────────────────────────────
app.post('/agent/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });
  // Accept any phone for POC — real backend checks agent exists
  console.log(`  → OTP for ${phone}: ${MOCK_OTP}`);
  res.json({ success: true, message: 'OTP sent to your registered number' });
});

// ─── POST /agent/auth/verify-otp ─────────────────────────────────────────────
app.post('/agent/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  if (otp !== MOCK_OTP) {
    return res.status(400).json({ success: false, message: 'Invalid code. Please try again.' });
  }
  // Look up or create agent on the fly for POC
  let agent = agents[phone];
  if (!agent) {
    const id = `ag_${Date.now()}`;
    agent = { id, name: 'Agent', phone, fcm_token: null };
    agents[phone] = agent;
  }
  const token = issueToken(agent);
  res.json({
    success: true,
    response: { token, agent: { id: agent.id, name: agent.name, phone: agent.phone } },
  });
});

// ─── POST /agent/auth/register-device ────────────────────────────────────────
app.post('/agent/auth/register-device', requireAgentAuth, (req, res) => {
  const { fcm_token } = req.body;
  const agent = Object.values(agents).find(a => a.id === req.agentId);
  if (agent && fcm_token) agent.fcm_token = fcm_token;
  res.json({ success: true });
});

// ─── POST /agent/auth/logout ──────────────────────────────────────────────────
app.post('/agent/auth/logout', requireAgentAuth, (_req, res) => {
  res.json({ success: true });
});

// ─── GET /agent/orders ────────────────────────────────────────────────────────
app.get('/agent/orders', requireAgentAuth, (req, res) => {
  const TERMINAL = ['delivered', 'cancelled', 'failed_delivery'];
  const agentOrders = Object.values(orders).filter(o => o.assigned_agent_id === req.agentId);

  const active = agentOrders
    .filter(o => !TERMINAL.includes(o.order_status))
    .map(o => ({
      order_id: o.order_id,
      order_status: o.order_status,
      patient_name: o.patient_name,
      patient_phone: o.patient_phone,
      delivery_address: o.delivery_address,
      delivery_area: o.delivery_area,
      items: o.items,
      distance_km: o.distance_km,
      stage_dates: o.stage_dates,
      assigned_at: o.assigned_at,
      out_for_delivery_at: o.out_for_delivery_at,
    }));

  const completed = agentOrders
    .filter(o => o.order_status === 'delivered')
    .map(o => ({
      order_id: o.order_id,
      order_status: o.order_status,
      patient_name: o.patient_name,
      delivery_area: o.delivery_area,
      delivered_at: o.delivered_at,
    }));

  res.json({
    success: true,
    response: {
      active,
      completed,
      summary: {
        active_count: active.length,
        today_count: active.length + completed.length,
        in_transit_count: active.filter(o => o.order_status === 'out_for_delivery').length,
      },
    },
  });
});

// ─── GET /agent/orders/:orderId ───────────────────────────────────────────────
app.get('/agent/orders/:orderId', requireAgentAuth, (req, res) => {
  const order = orders[req.params.orderId];
  if (!order || order.assigned_agent_id !== req.agentId) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  res.json({ success: true, response: order });
});

// ─── POST /agent/orders/:orderId/out-for-delivery ─────────────────────────────
app.post('/agent/orders/:orderId/out-for-delivery', requireAgentAuth, (req, res) => {
  const order = orders[req.params.orderId];
  if (!order || order.assigned_agent_id !== req.agentId) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  if (order.order_status === 'out_for_delivery') {
    return res.json({ success: true, response: { order_id: order.order_id, order_status: order.order_status, out_for_delivery_at: order.out_for_delivery_at } });
  }
  if (['delivered', 'cancelled', 'failed_delivery'].includes(order.order_status)) {
    return res.status(400).json({ success: false, message: 'Order is not ready to be dispatched' });
  }

  const label = nowLabel();
  order.order_status = 'out_for_delivery';
  order.out_for_delivery_at = nowISO();
  order.stage_dates.out_for_delivery = label;

  console.log(`  → ${order.order_id} → out_for_delivery`);
  res.json({ success: true, response: { order_id: order.order_id, order_status: order.order_status, out_for_delivery_at: order.out_for_delivery_at } });
});

// ─── POST /agent/orders/:orderId/deliver ──────────────────────────────────────
app.post('/agent/orders/:orderId/deliver', requireAgentAuth, upload.single('photo'), (req, res) => {
  const order = orders[req.params.orderId];
  if (!order || order.assigned_agent_id !== req.agentId) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Photo is required' });
  }
  if (order.order_status === 'delivered') {
    return res.json({ success: true, response: { order_id: order.order_id, order_status: order.order_status, delivered_at: order.delivered_at, proof_photo_url: order.proof_photo_url } });
  }

  const label = nowLabel();
  order.order_status = 'delivered';
  order.delivered_at = req.body.delivered_at || nowISO();
  order.proof_photo_url = `https://picsum.photos/seed/${order.order_id}/400/300`;
  order.stage_dates.delivered = label;

  console.log(`  → ${order.order_id} → delivered (photo: ${req.file.size} bytes)`);
  res.json({ success: true, response: { order_id: order.order_id, order_status: order.order_status, delivered_at: order.delivered_at, proof_photo_url: order.proof_photo_url } });
});

// ─── POST /agent/location ─────────────────────────────────────────────────────
app.post('/agent/location', requireAgentAuth, (req, res) => {
  const { lat, lng, bearing, accuracy, timestamp } = req.body;
  if (lat === undefined || lng === undefined || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, message: 'Invalid lat/lng' });
  }
  locationCache[req.agentId] = { lat, lng, bearing: bearing ?? 0, accuracy: accuracy ?? 0, reported_at: timestamp || nowISO() };
  res.json({ success: true });
});

// ─── GET /orders/:orderId/tracking  (patient app) ─────────────────────────────
// No agent auth — patient app calls this with its own token or no token for POC
app.get('/orders/:orderId/tracking', (req, res) => {
  const order = orders[req.params.orderId];
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const agent = Object.values(agents).find(a => a.id === order.assigned_agent_id);
  const location = locationCache[order.assigned_agent_id] || null;

  // ETA: compute from agent's last known location to delivery address
  let eta = null;
  if (location && order.order_status === 'out_for_delivery') {
    eta = computeETA(location.lat, location.lng, order.delivery_address.lat, order.delivery_address.lng);
  }

  res.json({
    success: true,
    response: {
      order_id: order.order_id,
      order_status: order.order_status,
      stage_dates: order.stage_dates,
      agent: agent ? { name: agent.name, phone: agent.phone } : null,
      agent_location: location,
      eta,
      delivered_at: order.delivered_at ?? null,
      proof_photo_url: order.proof_photo_url ?? null,
    },
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', orders: Object.keys(orders).length, agents: Object.keys(agents).length });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `No route: ${req.method} ${req.url}` });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('==========================================');
  console.log('  AZCares Delivery — POC Backend');
  console.log('==========================================');
  console.log(`  Port     : ${PORT}`);
  console.log(`  OTP      : ${MOCK_OTP}  (any phone works)`);
  console.log('');
  console.log('  Endpoints:');
  console.log('  POST /agent/auth/send-otp');
  console.log('  POST /agent/auth/verify-otp');
  console.log('  POST /agent/auth/register-device');
  console.log('  POST /agent/auth/logout');
  console.log('  GET  /agent/orders');
  console.log('  GET  /agent/orders/:id');
  console.log('  POST /agent/orders/:id/out-for-delivery');
  console.log('  POST /agent/orders/:id/deliver');
  console.log('  POST /agent/location');
  console.log('  GET  /orders/:id/tracking   ← patient app');
  console.log('  GET  /health');
  console.log('==========================================');
  console.log('');
});
